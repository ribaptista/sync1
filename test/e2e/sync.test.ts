import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-sync-root-"));
}

const PASSWORD = "correct horse battery staple";

function readStateDb(root: string): Database.Database {
  return new Database(path.join(root, ".sync1", "state.db"), { readonly: true });
}

function readCacheDb(root: string): Database.Database {
  return new Database(path.join(root, ".sync1", "cache.db"), { readonly: true });
}

describe("sync (local-to-remote, single machine)", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("dedupes identical content, reconciles cache.db, and records a new version", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();

    const init = await runCli(
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
    expect(init.exitCode).toBe(0);
    const initParsed = JSON.parse(init.stdout) as { version_stamp: string };

    // two files, identical content -> should dedup to one uploaded object
    fs.writeFileSync(path.join(root, "a.txt"), "duplicate content");
    fs.writeFileSync(path.join(root, "b.txt"), "duplicate content");
    fs.mkdirSync(path.join(root, "photos"));

    const sync = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(sync.stderr).toBe("");
    expect(sync.exitCode).toBe(0);
    const syncParsed = JSON.parse(sync.stdout) as {
      ok: boolean;
      version_stamp: string;
      nothing_to_sync: boolean;
      uploaded_objects: number;
      deduped_objects: number;
      entries_changed: number;
    };
    expect(syncParsed.ok).toBe(true);
    expect(syncParsed.version_stamp).not.toBe(initParsed.version_stamp);

    // exactly one object was uploaded (the shared content), one deduped
    expect(syncParsed.uploaded_objects).toBe(1);
    expect(syncParsed.deduped_objects).toBe(1);

    const newVersionStamp = syncParsed.version_stamp;

    // committed state.db: one object row, entries a.txt and b.txt share its hash, dir entry present
    const stateDb = readStateDb(root);
    const objectRows = stateDb.prepare("SELECT * FROM objects").all() as Array<{ hash: string }>;
    expect(objectRows).toHaveLength(1);
    const entryRows = stateDb
      .prepare("SELECT path, hash, type FROM entries ORDER BY path")
      .all() as Array<{ path: string; hash: string | null; type: string }>;
    expect(entryRows).toEqual([
      { path: "a.txt", hash: objectRows[0]!.hash, type: "file" },
      { path: "b.txt", hash: objectRows[0]!.hash, type: "file" },
      { path: "photos", hash: null, type: "dir" },
    ]);
    const versionRows = stateDb.prepare("SELECT version_stamp FROM versions").all() as Array<{
      version_stamp: string;
    }>;
    expect(versionRows.map((r) => r.version_stamp)).toEqual([
      initParsed.version_stamp,
      newVersionStamp,
    ]);
    stateDb.close();

    // the S3 objects/ prefix has exactly one object
    const s3Objects = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "objects/" }),
    );
    expect(s3Objects.KeyCount).toBe(1);

    // cache.db rows reconciled to unchanged, at the new baseline
    const cacheDb = readCacheDb(root);
    const cacheRows = cacheDb
      .prepare("SELECT path, state, parent_state_version FROM entries ORDER BY path")
      .all() as Array<{ path: string; state: string; parent_state_version: string }>;
    expect(cacheRows).toEqual([
      { path: "a.txt", state: "unchanged", parent_state_version: newVersionStamp },
      { path: "b.txt", state: "unchanged", parent_state_version: newVersionStamp },
      { path: "photos", state: "unchanged", parent_state_version: newVersionStamp },
    ]);
    cacheDb.close();

    // last_synced_version was advanced locally
    expect(fs.readFileSync(path.join(root, ".sync1", "last_synced_version"), "utf8")).toBe(
      newVersionStamp,
    );

    // a second sync with no changes reports nothing to do
    const secondSync = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    const secondParsed = JSON.parse(secondSync.stdout) as { nothing_to_sync: boolean };
    expect(secondParsed.nothing_to_sync).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("deletes an entry from state.db entirely (no tombstone) when a file is removed and synced", async () => {
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
    fs.writeFileSync(path.join(root, "a.txt"), "content");
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    fs.rmSync(path.join(root, "a.txt"));
    const result = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(result.exitCode).toBe(0);

    const stateDb = readStateDb(root);
    const rows = stateDb.prepare("SELECT path FROM entries").all();
    expect(rows).toEqual([]);
    stateDb.close();

    const cacheDb = readCacheDb(root);
    const cacheRows = cacheDb.prepare("SELECT path FROM entries").all();
    expect(cacheRows).toEqual([]); // no tombstone kept locally either
    cacheDb.close();

    fs.rmSync(root, { recursive: true, force: true });
  });
});
