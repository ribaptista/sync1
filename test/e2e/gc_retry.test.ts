import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";
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
import { parseManifest, unlockVault } from "../../src/vault/manifest.js";
import { parseRemoteConfig } from "../../src/vault/remote-config.js";
import { localVaultJsonPath, localRemoteConfigPath } from "../../src/vault/local-dir.js";
import { normalizePrefix, type RemoteLocation } from "../../src/vault/paths.js";
import { performGc } from "../../src/sync/gc.js";

const PASSWORD = "correct horse battery staple";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-gc-retry-"));
}

/**
 * performGc is called directly here (not via a spawned CLI process) because
 * genuinely racing two independent processes against a real, but fast,
 * LocalStack backend has no reliable window to land a competing commit in
 * -- the plan's own e2e guidance calls for constructing this scenario
 * deterministically. `onBeforeCas` is a test-only seam on performGc for
 * exactly this: a fixed point, immediately before the CAS attempt, to
 * inject a real competing commit from a second machine and force an
 * actual retry, rather than trusting real-world timing.
 */
describe("gc: CAS-conflict retry", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("refetches and recomputes when another commit lands between its read and its CAS attempt", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const rootA = mkTempRoot();
    const rootB = mkTempRoot();

    await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        rootA,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    fs.writeFileSync(path.join(rootA, "a.txt"), "will become an orphan");
    await runCli(["sync", "--root", rootA, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });
    fs.rmSync(path.join(rootA, "a.txt"));
    await runCli(["sync", "--root", rootA, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    const objectsBefore = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "objects/" }),
    );
    expect(objectsBefore.KeyCount).toBe(1);
    const objectKey = objectsBefore.Contents![0]!.Key!;

    await runCli(
      [
        "attach_remote",
        "--bucket",
        bucket,
        "--root",
        rootB,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );

    // Build the same S3/master-key context runGc's command wrapper would.
    const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(rootA)));
    const manifest = parseManifest(fs.readFileSync(localVaultJsonPath(rootA)));
    const masterKey = unlockVault(manifest, PASSWORD);
    const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
    const location: RemoteLocation = {
      bucket: remoteConfig.bucket,
      prefix: normalizePrefix(remoteConfig.prefix),
    };
    const logger = createLogger(false);

    let competingCommitDone = false;
    const result = await performGc(
      rootA,
      masterKey,
      { client, bucket: remoteConfig.bucket, location },
      true,
      logger,
      new PQueue({ concurrency: 8 }),
      16,
      async () => {
        if (competingCommitDone) return; // only race on the first attempt
        competingCommitDone = true;
        // A completely unrelated commit from a second machine, landing
        // exactly between gc's read of /current and its own CAS attempt --
        // this forces gc's first CAS to fail against a stale etag.
        fs.writeFileSync(path.join(rootB, "unrelated.txt"), "from B, mid-gc");
        const syncResult = await runCli(["sync", "--root", rootB, "--json"], {
          env: { SYNC1_PASSWORD: PASSWORD },
        });
        expect(syncResult.exitCode).toBe(0);
      },
    );

    // Success here is itself the proof the retry path ran: without it, the
    // CAS attempt against the now-stale etag would have thrown instead.
    expect(result).toEqual({ orphanCount: 1, reclaimedBytes: 21, applied: true }); // "will become an orphan".length
    expect(competingCommitDone).toBe(true);

    await expect(
      s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey })),
    ).rejects.toThrow();

    // The competing file from B is still intact in the final committed state.
    const finalObjects = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "objects/" }),
    );
    expect(finalObjects.KeyCount).toBe(1); // just B's "unrelated.txt" object now

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });
});
