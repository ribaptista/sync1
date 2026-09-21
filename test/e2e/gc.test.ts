import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";

interface RawEntryDeletionRow {
  path: string;
  type: string;
  hash: string | null;
  introduced_in_version: string;
  deleted_in_version: string;
}

function readEntryDeletions(root: string, forPath: string): RawEntryDeletionRow[] {
  const db = new Database(path.join(root, ".sync1", "state.db"), { readonly: true });
  const rows = db
    .prepare(
      "SELECT path, type, hash, introduced_in_version, deleted_in_version FROM entry_deletions WHERE path = ?",
    )
    .all(forPath) as RawEntryDeletionRow[];
  db.close();
  return rows;
}

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

  it("records a deletion in entry_deletions with both version stamps, and the row survives gc --apply after the object is gone", async () => {
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
    fs.writeFileSync(path.join(root, "a.txt"), "will be deleted");
    const createSync = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    const introducedInVersion = (JSON.parse(createSync.stdout) as { version_stamp: string })
      .version_stamp;

    fs.rmSync(path.join(root, "a.txt"));
    const deleteSync = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    const deletedInVersion = (JSON.parse(deleteSync.stdout) as { version_stamp: string })
      .version_stamp;

    const beforeGc = readEntryDeletions(root, "a.txt");
    expect(beforeGc).toHaveLength(1);
    expect(beforeGc[0]).toMatchObject({
      path: "a.txt",
      type: "file",
      introduced_in_version: introducedInVersion,
      deleted_in_version: deletedInVersion,
    });
    const hash = beforeGc[0]!.hash;
    expect(hash).toEqual(expect.any(String));

    const applied = await gc(root, true);
    expect(applied.parsed).toMatchObject({ applied: true, orphan_count: 1 });

    // The object is really gone from S3 now...
    const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "objects/" }));
    expect(objects.KeyCount).toBe(0);
    // ...but the history row survives, hash now dangling -- it records
    // what the hash *was*, not a live reference (see migration 0010).
    const afterGc = readEntryDeletions(root, "a.txt");
    expect(afterGc).toEqual(beforeGc);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
