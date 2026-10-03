import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import PQueue from "p-queue";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";
import { createLogger } from "../../src/logger.js";
import { createS3Client } from "../../src/s3/client.js";
import { parseRemoteConfig } from "../../src/vault/remote-config.js";
import { localRemoteConfigPath, localStateDbPath } from "../../src/vault/local-dir.js";
import { normalizePrefix, type RemoteLocation } from "../../src/vault/paths.js";
import { openStateDbReadOnly } from "../../src/db/connection.js";
import { ObjectsRepository } from "../../src/db/repositories/objects-repository.js";
import { convergeStoragePolicies } from "../../src/sync/converge-storage-policies.js";
import { hashBufferHex } from "../../src/crypto/hash.js";

const PASSWORD = "correct horse battery staple";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-converge-"));
}

async function sync(root: string) {
  return runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });
}

async function createPolicy(root: string, glob: string, targetClass: string) {
  const result = await runCli(
    ["storage_policy", "create", glob, targetClass, "--root", root, "--json"],
    { env: { SYNC1_PASSWORD: PASSWORD } },
  );
  expect(result.exitCode).toBe(0);
}

async function converge(root: string, filter?: string) {
  const args = ["converge", "--root", root, "--json"];
  if (filter) args.push("--filter", filter);
  const result = await runCli(args);
  return { ...result, parsed: JSON.parse(result.stdout) as Record<string, unknown> };
}

describe("converge", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("applies a full converge pass, moving an object to a colder class end-to-end", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();

    await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        root,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    fs.writeFileSync(path.join(root, "archive-me.txt"), "cold storage candidate");
    await sync(root);
    await createPolicy(root, "archive-me.txt", "DEEP_ARCHIVE");

    const objectsBefore = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "objects/" }),
    );
    const objectKey = objectsBefore.Contents?.[0]?.Key;
    expect(objectKey).toBeDefined();
    const headBefore = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey! }));
    expect(headBefore.StorageClass ?? "STANDARD").toBe("STANDARD");

    const result = await converge(root);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toMatchObject({ already_correct: 0, changed_immediate: 1 });

    const headAfter = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey! }));
    expect(headAfter.StorageClass).toBe("DEEP_ARCHIVE");

    // idempotent: running again reports already_correct, nothing to change
    const again = await converge(root);
    expect(again.parsed).toMatchObject({ already_correct: 1, changed_immediate: 0 });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("issues a restore request for a warmer target on a cold object", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();

    await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        root,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    fs.writeFileSync(path.join(root, "cold.txt"), "already archived");
    await sync(root);
    await createPolicy(root, "cold.txt", "GLACIER");
    await converge(root); // moves it to GLACIER first

    // now flip the policy back to STANDARD (a warmer target on a now-cold object)
    const policies = await runCli(["storage_policy", "list", "--root", root, "--json"]);
    const parsed = JSON.parse(policies.stdout) as {
      policies: Array<{ id: number; glob: string | null }>;
    };
    const policyId = parsed.policies.find((p) => p.glob === "cold.txt")!.id;
    await runCli(
      ["storage_policy", "edit", String(policyId), "--class", "STANDARD", "--root", root, "--json"],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );

    const result = await converge(root);
    expect(result.exitCode).toBe(0);
    // --apply issues the RestoreObject call; LocalStack accepting it
    // without erroring is what's actually verifiable here -- it doesn't
    // simulate real Glacier restore timing (see
    // docs/architecture/storage-classes-and-archive-restore.md).
    expect(result.parsed).toMatchObject({ restore_requested: 1 });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("converges a dedup conflict to the warmest of the disagreeing targets", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();

    await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        root,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    fs.writeFileSync(path.join(root, "cold-copy.txt"), "shared content");
    fs.writeFileSync(path.join(root, "warm-copy.txt"), "shared content");
    await sync(root);
    await createPolicy(root, "cold-copy.txt", "DEEP_ARCHIVE");
    // warm-copy.txt falls back to the default (STANDARD) -- disagreement.

    const result = await converge(root);
    expect(result.exitCode).toBe(0);
    // Already STANDARD (freshly synced), and warmest-wins resolves the
    // conflict to STANDARD too -- so nothing to change, but the
    // disagreement itself is still surfaced.
    expect(result.parsed).toMatchObject({ already_correct: 1, changed_immediate: 0 });
    const conflicts = result.parsed.conflicts as Array<{ target_class: string }>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.target_class).toBe("STANDARD");

    const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "objects/" }));
    expect(objects.KeyCount).toBe(1); // deduped -- one object, not two
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: objects.Contents![0]!.Key! }),
    );
    expect(head.StorageClass ?? "STANDARD").toBe("STANDARD"); // never archived colder than warm-copy.txt wants

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("scopes convergence via --filter", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();

    await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        root,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    fs.mkdirSync(path.join(root, "keep"));
    fs.mkdirSync(path.join(root, "other"));
    fs.writeFileSync(path.join(root, "keep", "a.txt"), "kept content");
    fs.writeFileSync(path.join(root, "other", "b.txt"), "other content");
    await sync(root);
    await createPolicy(root, "keep/*", "DEEP_ARCHIVE");
    await createPolicy(root, "other/*", "DEEP_ARCHIVE");

    const result = await converge(root, "keep/*");
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toMatchObject({ changed_immediate: 1 }); // only keep/a.txt's object

    const otherHead = await runCli(["status", "--root", root, "--filter", "other/*", "--json"]);
    expect(JSON.parse(otherHead.stdout)).toMatchObject({ changed_immediate: 1 }); // untouched by the scoped converge

    fs.rmSync(root, { recursive: true, force: true });
  });
});

/**
 * `convergeStoragePolicies` is called directly here, not through a spawned
 * CLI process, for the same reason `gc_retry.test.ts`/
 * `materialize_progress.test.ts` do: `copyOverrides` (`thresholdBytes`/
 * `partSizeBytes`) is a test-only seam with no CLI flag of its own, since
 * production never needs anything but the real 5 GiB / 512 MiB defaults --
 * see src/s3/copy-object.ts. This is what lets a ~12 MiB fixture exercise
 * the real multipart-copy path (3 parts, at a forced 5 MiB threshold/part
 * size) without an actual multi-GiB object.
 */
describe("converge: multipart storage-class copy for an object over the single-CopyObject limit", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("moves a >5MiB-forced-multipart object to a colder class, preserving its checksum and content byte-for-byte", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();

    await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        root,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );

    // ~12 MiB -- at the forced 5 MiB threshold/part size below, this is 3
    // parts (two full 5 MiB parts, one shorter), enough to exercise real
    // part-boundary behavior without an actual multi-GiB fixture.
    const content = crypto.randomBytes(12 * 1024 * 1024);
    const expectedHash = hashBufferHex(content);
    fs.writeFileSync(path.join(root, "video.bin"), content);
    await sync(root);
    await createPolicy(root, "video.bin", "DEEP_ARCHIVE");

    const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
    const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
    const location: RemoteLocation = {
      bucket: remoteConfig.bucket,
      prefix: normalizePrefix(remoteConfig.prefix),
    };
    const logger = createLogger(false);

    const stateDb = openStateDbReadOnly(localStateDbPath(root));
    const objectRowBefore = new ObjectsRepository(stateDb).get(expectedHash);
    stateDb.close();
    expect(objectRowBefore).toBeDefined();
    const expectedChecksum = objectRowBefore!.ciphertext_checksum;

    const objectsBefore = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "objects/" }),
    );
    const objectKey = objectsBefore.Contents?.[0]?.Key;
    expect(objectKey).toBeDefined();
    const headBefore = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey! }));
    expect(headBefore.StorageClass ?? "STANDARD").toBe("STANDARD");
    expect(headBefore.ContentLength).toBeGreaterThan(5 * 1024 * 1024); // confirms multipart will actually trigger below

    const result = await convergeStoragePolicies(
      root,
      "**",
      true,
      { client, bucket: remoteConfig.bucket, location },
      logger,
      new PQueue({ concurrency: 4 }),
      8,
      undefined,
      undefined,
      { thresholdBytes: 5 * 1024 * 1024, partSizeBytes: 5 * 1024 * 1024 },
    );
    expect(result.counts).toMatchObject({ alreadyCorrect: 0, changedImmediate: 1 });

    // ChecksumMode "ENABLED" is required to get ChecksumCRC64NVME back at
    // all -- without it S3 (and LocalStack, matching that behavior) omits
    // the field even for an object that has one stored. Same requirement
    // `headObject` (src/s3/client.ts) documents and sets by default.
    const headAfter = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: objectKey!, ChecksumMode: "ENABLED" }),
    );
    expect(headAfter.StorageClass).toBe("DEEP_ARCHIVE");
    // The multipart copy's FULL_OBJECT checksum must be byte-identical to
    // the one recorded at upload time -- not merely present, but the same
    // value -- which is exactly what a composite (per-part) checksum could
    // never guarantee across a different part layout. This is the real
    // proof of byte-for-byte integrity available here: a direct `GetObject`
    // to decrypt-and-compare against `content` isn't exercisable in this
    // test the way it is for a warm object, because the object is now
    // genuinely DEEP_ARCHIVE -- LocalStack enforces the same
    // `InvalidObjectState` a real archived object would (confirmed
    // directly: an un-restored `GetObject` against it fails exactly like
    // real S3), and LocalStack doesn't simulate real restore timing (see
    // docs/architecture/storage-classes-and-archive-restore.md), so a
    // restore-then-read round trip isn't reliably testable here either.
    // The checksum match is two independent confirmations of the same
    // fact: S3 itself verified the combined parts against `expectedChecksum`
    // at `CompleteMultipartUpload` time (inside `copyObjectStorageClass`),
    // and this `HeadObject`, made fresh from the test's own client after
    // the fact, independently confirms what S3 now has on record.
    expect(headAfter.ChecksumCRC64NVME).toBe(expectedChecksum);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
