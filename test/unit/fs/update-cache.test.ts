import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCacheDb, openStateDb } from "../../../src/db/connection.js";
import { CacheEntriesRepository } from "../../../src/db/repositories/cache-entries-repository.js";
import { ObjectsRepository } from "../../../src/db/repositories/objects-repository.js";
import { IgnorePoliciesRepository } from "../../../src/db/repositories/ignore-policies-repository.js";
import { hashFile } from "../../../src/fs/hash-file.js";
import { performUpdateCache, UnknownStubContentError } from "../../../src/fs/update-cache.js";
import { hashBufferHex } from "../../../src/crypto/hash.js";
import { writeStubAtomic } from "../../../src/fs/stub.js";

vi.mock("../../../src/fs/hash-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/fs/hash-file.js")>();
  return { hashFile: vi.fn(actual.hashFile) };
});

const hashFileMock = vi.mocked(hashFile);

const silentLogger = {
  debug: () => {},
  warn: () => {},
} as unknown as import("../../../src/logger.js").Logger;

let root: string;
let cacheDbPath: string;
let cacheDbDir: string;
let objectsRepo: ObjectsRepository;
let ignorePoliciesRepo: IgnorePoliciesRepository;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-update-cache-test-"));
  // The repo under test uses an in-memory cache.db (see makeRepo()), but
  // performUpdateCache still needs a real base path to derive its on-disk
  // staging file's sibling location from -- this path itself never needs to
  // exist. Deliberately NOT under `root`: in production cache.db lives under
  // `root/.sync1/`, which the walker explicitly excludes, but nothing excludes
  // an arbitrary path placed directly under `root` in these tests.
  cacheDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-update-cache-cachedb-"));
  cacheDbPath = path.join(cacheDbDir, "cache.db");
  hashFileMock.mockClear();
  // None of these tests exercise stub files, so this only ever needs to
  // exist -- stub-hash validation (the only thing that consults it) never
  // triggers for plain real files. See stub-specific tests for that path.
  const stateDb = openStateDb(":memory:");
  objectsRepo = new ObjectsRepository(stateDb);
  ignorePoliciesRepo = new IgnorePoliciesRepository(stateDb);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(cacheDbDir, { recursive: true, force: true });
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

    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(stats).toEqual({
      created: 1,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      caseCollisions: [],
      ignored: 0,
    });

    const row = repo.get("a.txt");
    expect(row?.state).toBe("created");
    expect(row?.hash).toHaveLength(64);
    expect(row?.parent_state_version).toBe("v0");
  });

  it("does not rehash a file whose mtime hasn't changed", async () => {
    touch("a.txt", "hello", 1_700_000_000_000);
    const repo = makeRepo();
    await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(hashFileMock).toHaveBeenCalledTimes(1);

    hashFileMock.mockClear();
    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(stats).toEqual({
      created: 0,
      modified: 0,
      deleted: 0,
      unchanged: 1,
      caseCollisions: [],
      ignored: 0,
    });
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
    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v1",
      silentLogger,
    );
    expect(stats).toEqual({
      created: 0,
      modified: 1,
      deleted: 0,
      unchanged: 0,
      caseCollisions: [],
      ignored: 0,
    });
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
    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(stats).toEqual({
      created: 0,
      modified: 0,
      deleted: 0,
      unchanged: 1,
      caseCollisions: [],
      ignored: 0,
    });
    expect(repo.get("a.txt")?.state).toBe("unchanged");
    expect(repo.get("a.txt")?.mtime).toBe(1_700_000_005_000);
  });

  it("detects a deleted file and clears its hash/mtime", async () => {
    touch("a.txt", "hello");
    const repo = makeRepo();
    await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );

    fs.rmSync(path.join(root, "a.txt"));
    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(stats).toEqual({
      created: 0,
      modified: 0,
      deleted: 1,
      unchanged: 0,
      caseCollisions: [],
      ignored: 0,
    });
    const row = repo.get("a.txt");
    expect(row?.state).toBe("deleted");
    expect(row?.hash).toBeNull();
    expect(row?.mtime).toBeNull();
  });

  it("is idempotent for an already-deleted tombstone", async () => {
    touch("a.txt", "hello");
    const repo = makeRepo();
    await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    fs.rmSync(path.join(root, "a.txt"));
    await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );

    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(stats).toEqual({
      created: 0,
      modified: 0,
      deleted: 1,
      unchanged: 0,
      caseCollisions: [],
      ignored: 0,
    });
  });

  it("treats a file recreated at a previously-deleted path as a fresh creation", async () => {
    touch("a.txt", "hello");
    const repo = makeRepo();
    await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    fs.rmSync(path.join(root, "a.txt"));
    await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );

    touch("a.txt", "brand new content");
    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(stats).toEqual({
      created: 1,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      caseCollisions: [],
      ignored: 0,
    });
    expect(repo.get("a.txt")?.state).toBe("created");
  });

  it("keeps the original baseline when a still-pending change is edited again", async () => {
    touch("a.txt", "hello", 1_700_000_000_000);
    const repo = makeRepo();
    await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    ); // -> created, baseline v0

    // a sync would normally happen here and bump last_synced_version, but
    // suppose the user edits the file again before running sync
    touch("a.txt", "hello again", 1_700_000_001_000);
    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(stats).toEqual({
      created: 1,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      caseCollisions: [],
      ignored: 0,
    });
    const row = repo.get("a.txt");
    expect(row?.state).toBe("created"); // still 'created', not flipped to 'modified'
    expect(row?.parent_state_version).toBe("v0"); // unchanged baseline
  });

  it("creates directory rows with a null hash and never rehashes them", async () => {
    fs.mkdirSync(path.join(root, "photos"));
    touch("photos/img.jpg", "data");
    const repo = makeRepo();
    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(stats).toEqual({
      created: 2,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      caseCollisions: [],
      ignored: 0,
    });
    expect(repo.get("photos")?.hash).toBeNull();
    expect(repo.get("photos")?.type).toBe("dir");
  });
});

describe("performUpdateCache: ignore policies", () => {
  it("skips a new file matching an ignore policy, without tracking it", async () => {
    ignorePoliciesRepo.create("*.tmp");
    touch("scratch.tmp", "throwaway");
    const repo = makeRepo();

    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(stats).toEqual({
      created: 0,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      caseCollisions: [],
      ignored: 1,
    });
    expect(repo.get("scratch.tmp")).toBeUndefined();
  });

  it("still applies an unrelated new file in the same run as an ignored one", async () => {
    ignorePoliciesRepo.create("*.tmp");
    touch("scratch.tmp", "throwaway");
    touch("keep.txt", "hello");
    const repo = makeRepo();

    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(stats).toEqual({
      created: 1,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      caseCollisions: [],
      ignored: 1,
    });
    expect(repo.get("scratch.tmp")).toBeUndefined();
    expect(repo.get("keep.txt")?.state).toBe("created");
  });
});

describe("performUpdateCache: stub files", () => {
  it("treats a legitimate new stub as a normal creation, without hashing its (contentless) bytes", async () => {
    const knownHash = hashBufferHex(Buffer.from("this content already lives in the vault"));
    objectsRepo.upsert({ hash: knownHash, s3_key: `objects/${knownHash}`, size: 42 });
    writeStubAtomic(path.join(root, "img.jpg.stub"), knownHash);

    const repo = makeRepo();
    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(stats).toEqual({
      created: 1,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      caseCollisions: [],
      ignored: 0,
    });
    expect(hashFileMock).not.toHaveBeenCalled(); // never hashes the stub's own bytes
    const row = repo.get("img.jpg");
    expect(row?.hash).toBe(knownHash);
    expect(row?.state).toBe("created");
  });

  it("rejects a stub with malformed content", async () => {
    fs.writeFileSync(path.join(root, "bad.jpg.stub"), "not-a-valid-tagged-hash");
    const repo = makeRepo();
    await expect(
      performUpdateCache(
        root,
        cacheDbPath,
        repo,
        objectsRepo,
        ignorePoliciesRepo,
        "v0",
        silentLogger,
      ),
    ).rejects.toThrow(/corrupt stub/);
  });

  it("rejects a stub whose declared hash isn't known to this vault", async () => {
    const unknownHash = "b".repeat(64);
    writeStubAtomic(path.join(root, "img.jpg.stub"), unknownHash);
    const repo = makeRepo();
    await expect(
      performUpdateCache(
        root,
        cacheDbPath,
        repo,
        objectsRepo,
        ignorePoliciesRepo,
        "v0",
        silentLogger,
      ),
    ).rejects.toThrow(UnknownStubContentError);
  });

  it("auto-cleans a dangling stub when both it and the real file exist, treating the real file as canonical", async () => {
    touch("img.jpg", "the real content", 1_700_000_000_000);
    // a stray stub with a DIFFERENT (even bogus) hash -- proves the real
    // file wins regardless of what the dangling stub claims
    writeStubAtomic(path.join(root, "img.jpg.stub"), "c".repeat(64));

    const repo = makeRepo();
    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(stats).toEqual({
      created: 1,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      caseCollisions: [],
      ignored: 0,
    });
    expect(repo.get("img.jpg")?.hash).toBe(hashBufferHex(Buffer.from("the real content")));
    expect(fs.existsSync(path.join(root, "img.jpg.stub"))).toBe(false); // cleaned up
  });

  it("does not re-validate a steady-state stub whose mtime hasn't changed", async () => {
    const knownHash = hashBufferHex(Buffer.from("steady content"));
    objectsRepo.upsert({ hash: knownHash, s3_key: `objects/${knownHash}`, size: 1 });
    const stubPath = path.join(root, "img.jpg.stub");
    writeStubAtomic(stubPath, knownHash);
    const stubMtime = Math.round(fs.statSync(stubPath).mtimeMs);

    const repo = makeRepo();
    repo.upsert({
      path: "img.jpg",
      type: "file",
      mtime: stubMtime,
      hash: knownHash,
      state: "unchanged",
      parent_state_version: "v0",
    });

    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(stats).toEqual({
      created: 0,
      modified: 0,
      deleted: 0,
      unchanged: 1,
      caseCollisions: [],
      ignored: 0,
    });
  });
});

describe("performUpdateCache: staging file lifecycle", () => {
  it("leaves no staging file behind after a successful run", async () => {
    touch("a.txt", "hello");
    const repo = makeRepo();
    await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(fs.readdirSync(cacheDbDir)).toEqual([]);
  });

  it("leaves no staging file behind after a run that throws", async () => {
    fs.writeFileSync(path.join(root, "bad.jpg.stub"), "not-a-valid-tagged-hash");
    const repo = makeRepo();
    await expect(
      performUpdateCache(
        root,
        cacheDbPath,
        repo,
        objectsRepo,
        ignorePoliciesRepo,
        "v0",
        silentLogger,
      ),
    ).rejects.toThrow(/corrupt stub/);
    expect(fs.readdirSync(cacheDbDir)).toEqual([]);
  });
});

describe("performUpdateCache: case-insensitive collision detection", () => {
  it("applies a rename (tombstone + case-variant create in the same batch) with no collision reported", async () => {
    const repo = makeRepo();
    // Simulate "file.txt" already fully synced, then renamed to "FILE.txt"
    // on disk before the next scan -- update_cache sees this as one path
    // vanishing and a case-variant appearing in the very same run.
    repo.upsert({
      path: "file.txt",
      type: "file",
      mtime: 1_700_000_000_000,
      hash: hashBufferHex(Buffer.from("hello")),
      state: "unchanged",
      parent_state_version: "v0",
    });
    touch("FILE.txt", "hello");

    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );
    expect(stats.caseCollisions).toEqual([]);
    expect(repo.get("file.txt")?.state).toBe("deleted");
    expect(repo.get("FILE.txt")?.state).toBe("created");
  });

  it("reports a genuine collision, applies every other row, and leaves neither colliding path tracked", async () => {
    touch("file.txt", "one");
    touch("FILE.txt", "two");
    touch("other.txt", "unrelated");
    const repo = makeRepo();

    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );

    expect(stats.caseCollisions).toHaveLength(2);
    const collidingPaths = stats.caseCollisions.map((c) => c.path).sort();
    expect(collidingPaths).toEqual(["FILE.txt", "file.txt"]);
    for (const c of stats.caseCollisions) {
      expect(["FILE.txt", "file.txt"]).toContain(c.collidesWith);
    }

    // neither colliding path got tracked...
    expect(repo.get("file.txt")).toBeUndefined();
    expect(repo.get("FILE.txt")).toBeUndefined();
    // ...but the unrelated new file still applied normally
    expect(repo.get("other.txt")?.state).toBe("created");
  });

  it("a durable cache.db collision does not block an unrelated file in the same batch", async () => {
    const repo = makeRepo();
    repo.upsert({
      path: "file.txt",
      type: "file",
      mtime: 1_700_000_000_000,
      hash: hashBufferHex(Buffer.from("existing")),
      state: "unchanged",
      parent_state_version: "v0",
    });
    touch("file.txt", "existing", 1_700_000_000_000); // matches cache.db's baseline, stays untouched
    touch("FILE.txt", "new content"); // collides with the existing "file.txt" row
    touch("other.txt", "unrelated");

    const stats = await performUpdateCache(
      root,
      cacheDbPath,
      repo,
      objectsRepo,
      ignorePoliciesRepo,
      "v0",
      silentLogger,
    );

    expect(stats.caseCollisions).toEqual([{ path: "FILE.txt", collidesWith: "file.txt" }]);
    expect(repo.get("FILE.txt")).toBeUndefined();
    expect(repo.get("other.txt")?.state).toBe("created");
  });
});
