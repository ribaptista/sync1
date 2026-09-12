import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCacheDb } from "../../../src/db/connection.js";
import { CacheEntriesRepository } from "../../../src/db/repositories/cache-entries-repository.js";
import { hashFile } from "../../../src/fs/hash-file.js";
import { performUpdateCache } from "../../../src/fs/update-cache.js";
import { hashBufferHex } from "../../../src/crypto/hash.js";

vi.mock("../../../src/fs/hash-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/fs/hash-file.js")>();
  return { hashFile: vi.fn(actual.hashFile) };
});

const hashFileMock = vi.mocked(hashFile);

const silentLogger = { debug: () => {} } as unknown as import("../../../src/logger.js").Logger;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-update-cache-test-"));
  hashFileMock.mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeRepo() {
  const db = openCacheDb(":memory:");
  return new CacheEntriesRepository(db);
}

function touch(relPath: string, content: string, mtimeMs?: number): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (mtimeMs !== undefined) {
    const t = mtimeMs / 1000;
    fs.utimesSync(abs, t, t);
  }
}

describe("performUpdateCache", () => {
  it("detects a newly created file and computes its hash", async () => {
    touch("a.txt", "hello");
    const repo = makeRepo();

    const stats = await performUpdateCache(root, repo, "v0", silentLogger);
    expect(stats).toEqual({ created: 1, modified: 0, deleted: 0, unchanged: 0 });

    const row = repo.get("a.txt");
    expect(row?.state).toBe("created");
    expect(row?.hash).toHaveLength(64);
    expect(row?.parent_state_version).toBe("v0");
  });

  it("does not rehash a file whose mtime hasn't changed", async () => {
    touch("a.txt", "hello", 1_700_000_000_000);
    const repo = makeRepo();
    await performUpdateCache(root, repo, "v0", silentLogger);
    expect(hashFileMock).toHaveBeenCalledTimes(1);

    hashFileMock.mockClear();
    const stats = await performUpdateCache(root, repo, "v0", silentLogger);
    expect(stats).toEqual({ created: 0, modified: 0, deleted: 0, unchanged: 1 });
    expect(hashFileMock).not.toHaveBeenCalled();
  });

  it("detects a real content modification (mtime and hash both differ)", async () => {
    // Seed a row already at 'unchanged' baseline (as if a prior sync had
    // already committed it) -- update_cache/sync alone never produces this
    // transition, only a real sync does, so seed it directly.
    touch("a.txt", "hello", 1_700_000_000_000);
    const repo = makeRepo();
    repo.upsert({
      path: "a.txt",
      type: "file",
      mtime: 1_700_000_000_000,
      hash: hashBufferHex(Buffer.from("hello")),
      state: "unchanged",
      parent_state_version: "v0",
    });

    touch("a.txt", "goodbye", 1_700_000_001_000);
    const stats = await performUpdateCache(root, repo, "v1", silentLogger);
    expect(stats).toEqual({ created: 0, modified: 1, deleted: 0, unchanged: 0 });
    const row = repo.get("a.txt");
    expect(row?.state).toBe("modified");
    expect(row?.parent_state_version).toBe("v1"); // fresh baseline, established now
  });

  it("treats a touch with no real content change (same hash) as still unchanged", async () => {
    touch("a.txt", "hello", 1_700_000_000_000);
    const repo = makeRepo();
    repo.upsert({
      path: "a.txt",
      type: "file",
      mtime: 1_700_000_000_000,
      hash: hashBufferHex(Buffer.from("hello")),
      state: "unchanged",
      parent_state_version: "v0",
    });

    touch("a.txt", "hello", 1_700_000_005_000); // mtime bumped, content identical
    const stats = await performUpdateCache(root, repo, "v0", silentLogger);
    expect(stats).toEqual({ created: 0, modified: 0, deleted: 0, unchanged: 1 });
    expect(repo.get("a.txt")?.state).toBe("unchanged");
    expect(repo.get("a.txt")?.mtime).toBe(1_700_000_005_000);
  });

  it("detects a deleted file and clears its hash/mtime", async () => {
    touch("a.txt", "hello");
    const repo = makeRepo();
    await performUpdateCache(root, repo, "v0", silentLogger);

    fs.rmSync(path.join(root, "a.txt"));
    const stats = await performUpdateCache(root, repo, "v0", silentLogger);
    expect(stats).toEqual({ created: 0, modified: 0, deleted: 1, unchanged: 0 });
    const row = repo.get("a.txt");
    expect(row?.state).toBe("deleted");
    expect(row?.hash).toBeNull();
    expect(row?.mtime).toBeNull();
  });

  it("is idempotent for an already-deleted tombstone", async () => {
    touch("a.txt", "hello");
    const repo = makeRepo();
    await performUpdateCache(root, repo, "v0", silentLogger);
    fs.rmSync(path.join(root, "a.txt"));
    await performUpdateCache(root, repo, "v0", silentLogger);

    const stats = await performUpdateCache(root, repo, "v0", silentLogger);
    expect(stats).toEqual({ created: 0, modified: 0, deleted: 1, unchanged: 0 });
  });

  it("treats a file recreated at a previously-deleted path as a fresh creation", async () => {
    touch("a.txt", "hello");
    const repo = makeRepo();
    await performUpdateCache(root, repo, "v0", silentLogger);
    fs.rmSync(path.join(root, "a.txt"));
    await performUpdateCache(root, repo, "v0", silentLogger);

    touch("a.txt", "brand new content");
    const stats = await performUpdateCache(root, repo, "v0", silentLogger);
    expect(stats).toEqual({ created: 1, modified: 0, deleted: 0, unchanged: 0 });
    expect(repo.get("a.txt")?.state).toBe("created");
  });

  it("keeps the original baseline when a still-pending change is edited again", async () => {
    touch("a.txt", "hello", 1_700_000_000_000);
    const repo = makeRepo();
    await performUpdateCache(root, repo, "v0", silentLogger); // -> created, baseline v0

    // a sync would normally happen here and bump last_synced_version, but
    // suppose the user edits the file again before running sync
    touch("a.txt", "hello again", 1_700_000_001_000);
    const stats = await performUpdateCache(root, repo, "v0", silentLogger);
    expect(stats).toEqual({ created: 1, modified: 0, deleted: 0, unchanged: 0 });
    const row = repo.get("a.txt");
    expect(row?.state).toBe("created"); // still 'created', not flipped to 'modified'
    expect(row?.parent_state_version).toBe("v0"); // unchanged baseline
  });

  it("creates directory rows with a null hash and never rehashes them", async () => {
    fs.mkdirSync(path.join(root, "photos"));
    touch("photos/img.jpg", "data");
    const repo = makeRepo();
    const stats = await performUpdateCache(root, repo, "v0", silentLogger);
    expect(stats).toEqual({ created: 2, modified: 0, deleted: 0, unchanged: 0 });
    expect(repo.get("photos")?.hash).toBeNull();
    expect(repo.get("photos")?.type).toBe("dir");
  });
});
