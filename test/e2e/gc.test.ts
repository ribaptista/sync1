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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-gc-"));
}

async function gc(root: string, apply: boolean) {
  const args = ["gc", "--root", root, "--json"];
  if (apply) args.push("--apply");
  const result = await runCli(args, { env: { SYNC1_PASSWORD: PASSWORD } });
  return { ...result, parsed: JSON.parse(result.stdout) as Record<string, unknown> };
}

describe("gc", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("counts then removes an orphaned object after a file is deleted and synced", async () => {
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
    fs.writeFileSync(path.join(root, "a.txt"), "orphan me later");
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    const objectsBefore = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "objects/" }),
    );
    expect(objectsBefore.KeyCount).toBe(1);
    const objectKey = objectsBefore.Contents![0]!.Key!;

    fs.rmSync(path.join(root, "a.txt"));
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    const countOnly = await gc(root, false);
    expect(countOnly.exitCode).toBe(0);
    expect(countOnly.parsed).toMatchObject({ applied: false, orphan_count: 1 });

    // count-only made no change
    const stillThere = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    expect(stillThere.ContentLength).toBeGreaterThan(0);

    const applied = await gc(root, true);
    expect(applied.exitCode).toBe(0);
    expect(applied.parsed).toMatchObject({ applied: true, orphan_count: 1 });
    expect(applied.parsed.reclaimed_bytes).toBe(15); // "orphan me later".length

    await expect(
      s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey })),
    ).rejects.toThrow();

    const secondGc = await gc(root, true);
    expect(secondGc.parsed).toMatchObject({ orphan_count: 0, applied: false });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("never touches an object still referenced by another path (dedup)", async () => {
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
    fs.writeFileSync(path.join(root, "a.txt"), "shared content");
    fs.writeFileSync(path.join(root, "b.txt"), "shared content");
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    fs.rmSync(path.join(root, "a.txt")); // b.txt still references the same object
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    const result = await gc(root, true);
    expect(result.parsed).toMatchObject({ orphan_count: 0, applied: false });

    const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "objects/" }));
    expect(objects.KeyCount).toBe(1); // still there, still referenced by b.txt

    fs.rmSync(root, { recursive: true, force: true });
  });
});
