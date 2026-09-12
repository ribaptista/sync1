import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";

const PASSWORD = "correct horse battery staple";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-esc-"));
}

async function ensureStorageClass(root: string, glob: string, targetClass: string, apply: boolean) {
  const args = ["ensure_storage_class", glob, targetClass, "--root", root, "--json"];
  if (apply) args.push("--apply");
  const result = await runCli(args, { env: { SYNC1_PASSWORD: PASSWORD } });
  return { ...result, parsed: JSON.parse(result.stdout) as Record<string, unknown> };
}

describe("ensure_storage_class", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("moves an object to a colder class immediately, end-to-end", async () => {
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
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    // count-only first: reports it needs an immediate change, doesn't touch anything
    const countOnly = await ensureStorageClass(root, "archive-me.txt", "DEEP_ARCHIVE", false);
    expect(countOnly.exitCode).toBe(0);
    expect(countOnly.parsed).toMatchObject({
      applied: false,
      already_correct: 0,
      changed_immediate: 1,
    });

    const objectsList = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "objects/" }),
    );
    const objectKey = objectsList.Contents?.[0]?.Key;
    expect(objectKey).toBeDefined();
    const headBefore = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey! }));
    expect(headBefore.StorageClass ?? "STANDARD").toBe("STANDARD"); // count-only made no change

    // now actually apply it
    const applied = await ensureStorageClass(root, "archive-me.txt", "DEEP_ARCHIVE", true);
    expect(applied.exitCode).toBe(0);
    expect(applied.parsed).toMatchObject({ applied: true, changed_immediate: 1 });

    const headAfter = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey! }));
    expect(headAfter.StorageClass).toBe("DEEP_ARCHIVE");

    // running it again is idempotent: already correct, nothing to change
    const again = await ensureStorageClass(root, "archive-me.txt", "DEEP_ARCHIVE", true);
    expect(again.parsed).toMatchObject({ already_correct: 1, changed_immediate: 0 });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("issues a restore request for a warmer target on a cold object (count mode and --apply)", async () => {
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
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });
    await ensureStorageClass(root, "cold.txt", "GLACIER", true);

    const countOnly = await ensureStorageClass(root, "cold.txt", "STANDARD", false);
    expect(countOnly.exitCode).toBe(0);
    expect(countOnly.parsed).toMatchObject({ applied: false, restore_requested: 1 });

    // --apply issues the RestoreObject call; LocalStack accepting it without
    // erroring is what's actually verifiable here -- it doesn't simulate
    // real Glacier restore timing, so we don't assert on post-restore HEAD
    // status (see docs/architecture/storage-classes-and-archive-restore.md).
    const applied = await ensureStorageClass(root, "cold.txt", "STANDARD", true);
    expect(applied.exitCode).toBe(0);
    expect(applied.parsed).toMatchObject({ applied: true, restore_requested: 1 });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("processes a shared (deduped) object once, not once per matching path", async () => {
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
    fs.writeFileSync(path.join(root, "dup-a.txt"), "identical content");
    fs.writeFileSync(path.join(root, "dup-b.txt"), "identical content");
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    const result = await ensureStorageClass(root, "dup-*.txt", "DEEP_ARCHIVE", true);
    expect(result.parsed).toMatchObject({ changed_immediate: 1 }); // one object, not two

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects an unsupported storage class name", async () => {
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

    const result = await ensureStorageClass(root, "*", "GLACIER_IR", false);
    expect(result.exitCode).not.toBe(0);
    expect(result.parsed.error).toMatch(/unsupported storage class/);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
