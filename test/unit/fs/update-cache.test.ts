import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCacheDb, openStateDb } from "../../../src/db/connection.js";
import { CacheEntriesRepository } from "../../../src/db/repositories/cache-entries-repository.js";
import { ObjectsRepository } from "../../../src/db/repositories/objects-repository.js";
import { IgnorePoliciesRepository } from "../../../src/db/repositories/ignore-policies-repository.js";
import { hashFile } from "../../../src/fs/hash-file.js";
import {
  performUpdateCache,
  UnknownStubContentError,
  type UpdateCacheStats,
} from "../../../src/fs/update-cache.js";
import type { HashRunner } from "../../../src/concurrency/hash-runner.js";
import { hashBufferHex } from "../../../src/crypto/hash.js";
import { writeStubAtomic } from "../../../src/fs/stub.js";
import type { OnProgress } from "../../../src/progress-types.js";

vi.mock("../../../src/fs/hash-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/fs/hash-file.js")>();
  return { hashFile: vi.fn(actual.hashFile) };
});

const hashFileMock = vi.mocked(hashFile);

const silentLogger = {
  debug: () => {},
  warn: () => {},
} as unknown as import("../../../src/logger.js").Logger;

// The default HashRunner used by most tests below just delegates to the
// (mockable) hashFile function -- this is what lets every test that only
// cares about *whether/when* a file gets hashed, not the concurrency
// mechanics themselves, keep asserting against `hashFileMock` exactly as
// before. Dedicated concurrency-specific tests further down inject their own
// fake HashRunner instead, per the plan's "never through a real Piscina pool
// in tests" note.
const defaultHashRunner: HashRunner = { run: (absolutePath) => hashFile(absolutePath) };
const DEFAULT_MAX_IN_FLIGHT = 4;

let root: string;
let cacheDbPath: string;
let cacheDbDir: string;
let objectsRepo: ObjectsRepository;
let ignorePoliciesRepo: IgnorePoliciesRepository;

function run(
  repo: CacheEntriesRepository,
  options: {
    version?: string;
    onProgress?: OnProgress;
    hashRunner?: HashRunner;
    maxInFlightHashes?: number;
  } = {},
): Promise<UpdateCacheStats> {
  return performUpdateCache(
    root,
    cacheDbPath,
    repo,
    objectsRepo,
    ignorePoliciesRepo,
    options.version ?? "v0",
    silentLogger,
    options.hashRunner ?? defaultHashRunner,
    options.maxInFlightHashes ?? DEFAULT_MAX_IN_FLIGHT,
    options.onProgress,
  );
}

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

    const stats = await run(repo);
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
    await run(repo);
    expect(hashFileMock).toHaveBeenCalledTimes(1);

    hashFileMock.mockClear();
    const stats = await run(repo);
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
      size: 5,
      state: "unchanged",
      parent_state_version: "v0",
    });

    touch("a.txt", "goodbye", 1_700_000_001_000);
    const stats = await run(repo, { version: "v1" });
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
    // Carried over from the row itself, NOT re-stamped from the run's
    // lastSyncedVersion ("v1" here). The baseline answers "which vault
    // version is this local change based on", and dirtying a file doesn't
    // change that answer -- the vault's row for "a.txt" is still at "v0".
    // See the invariant note in src/fs/update-cache.ts.
    expect(row?.parent_state_version).toBe("v0");
  });

  it("treats a touch with no real content change (same hash) as still unchanged", async () => {
    touch("a.txt", "hello", 1_700_000_000_000);
    const repo = makeRepo();
    repo.upsert({
      path: "a.txt",
      type: "file",
      mtime: 1_700_000_000_000,
      hash: hashBufferHex(Buffer.from("hello")),
      size: 5,
      state: "unchanged",
      parent_state_version: "v0",
    });

    touch("a.txt", "hello", 1_700_000_005_000); // mtime bumped, content identical
    const stats = await run(repo);
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
    await run(repo);

    fs.rmSync(path.join(root, "a.txt"));
    const stats = await run(repo);
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

  it("keeps a deleted row's own baseline when the global version stamp has moved on", async () => {
    // The regression this guards: a policy mutation (ignore/storage_policy/
    // thumbnail_policy) mints a new vault version and advances
    // .sync1/last_synced_version without touching `entries` at all -- so the
    // global stamp routinely runs ahead of any given path's own row. Stamping
    // a locally-deleted row with that global value made sync compare the
    // vault's "v0" row against a "v5" baseline and report every deletion as
    // "was deleted locally, but modified remotely".
    touch("a.txt", "hello", 1_700_000_000_000);
    const repo = makeRepo();
    repo.upsert({
      path: "a.txt",
      type: "file",
      mtime: 1_700_000_000_000,
      hash: hashBufferHex(Buffer.from("hello")),
      size: 5,
      state: "unchanged",
      parent_state_version: "v0",
    });

    fs.rmSync(path.join(root, "a.txt"));
    const stats = await run(repo, { version: "v5" });
    expect(stats.deleted).toBe(1);

    const row = repo.get("a.txt");
    expect(row?.state).toBe("deleted");
    expect(row?.parent_state_version).toBe("v0");
  });

  it("is idempotent for an already-deleted tombstone", async () => {
    touch("a.txt", "hello");
    const repo = makeRepo();
    await run(repo);
    fs.rmSync(path.join(root, "a.txt"));
    await run(repo);

    const stats = await run(repo);
    // Zero, not one: the tombstone was already written by the previous run,
    // and this scan made no transition. `deleted` counts transitions this
    // scan actually performed, the same way created/modified do -- counting
    // the early return too made repeat scans claim deletions they never wrote.
    expect(stats).toEqual({
      created: 0,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      caseCollisions: [],
      ignored: 0,
    });
    // ...and the tombstone itself is untouched.
    expect(repo.get("a.txt")?.state).toBe("deleted");
  });

  it("treats a file recreated at a previously-deleted path as a fresh creation", async () => {
    touch("a.txt", "hello");
    const repo = makeRepo();
    await run(repo);
    fs.rmSync(path.join(root, "a.txt"));
    await run(repo);

    touch("a.txt", "brand new content");
    const stats = await run(repo);
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
    await run(repo); // -> created, baseline v0

    // a sync would normally happen here and bump last_synced_version, but
    // suppose the user edits the file again before running sync
    touch("a.txt", "hello again", 1_700_000_001_000);
    const stats = await run(repo);
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
    const stats = await run(repo);
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

    const stats = await run(repo);
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

    const stats = await run(repo);
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
    const stats = await run(repo);
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
    await expect(run(repo)).rejects.toThrow(/corrupt stub/);
  });

  it("rejects a stub whose declared hash isn't known to this vault", async () => {
    const unknownHash = "b".repeat(64);
    writeStubAtomic(path.join(root, "img.jpg.stub"), unknownHash);
    const repo = makeRepo();
    await expect(run(repo)).rejects.toThrow(UnknownStubContentError);
  });

  it("auto-cleans a dangling stub when both it and the real file exist, treating the real file as canonical", async () => {
    touch("img.jpg", "the real content", 1_700_000_000_000);
    // a stray stub with a DIFFERENT (even bogus) hash -- proves the real
    // file wins regardless of what the dangling stub claims
    writeStubAtomic(path.join(root, "img.jpg.stub"), "c".repeat(64));

    const repo = makeRepo();
    const stats = await run(repo);
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
      size: 1,
      state: "unchanged",
      parent_state_version: "v0",
    });

    const stats = await run(repo);
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
    await run(repo);
    expect(fs.readdirSync(cacheDbDir)).toEqual([]);
  });

  it("leaves no staging file behind after a run that throws", async () => {
    fs.writeFileSync(path.join(root, "bad.jpg.stub"), "not-a-valid-tagged-hash");
    const repo = makeRepo();
    await expect(run(repo)).rejects.toThrow(/corrupt stub/);
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
      size: 5,
      state: "unchanged",
      parent_state_version: "v0",
    });
    touch("FILE.txt", "hello");

    const stats = await run(repo);
    expect(stats.caseCollisions).toEqual([]);
    expect(repo.get("file.txt")?.state).toBe("deleted");
    expect(repo.get("FILE.txt")?.state).toBe("created");
  });

  it("reports a genuine collision, applies every other row, and leaves neither colliding path tracked", async () => {
    touch("file.txt", "one");
    touch("FILE.txt", "two");
    touch("other.txt", "unrelated");
    const repo = makeRepo();

    const stats = await run(repo);

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
      size: 8,
      state: "unchanged",
      parent_state_version: "v0",
    });
    touch("file.txt", "existing", 1_700_000_000_000); // matches cache.db's baseline, stays untouched
    touch("FILE.txt", "new content"); // collides with the existing "file.txt" row
    touch("other.txt", "unrelated");

    const stats = await run(repo);

    expect(stats.caseCollisions).toEqual([{ path: "FILE.txt", collidesWith: "file.txt" }]);
    expect(repo.get("FILE.txt")).toBeUndefined();
    expect(repo.get("other.txt")?.state).toBe("created");
  });
});

describe("performUpdateCache: hash dispatch concurrency", () => {
  // A controllable fake HashRunner -- never a real Piscina pool in a unit
  // test (slow, and defeats the point of a fast unit suite). Tracks how many
  // calls are concurrently unresolved, and lets the test resolve them in
  // whatever order it chooses, to prove the final result doesn't depend on
  // completion order.
  function makeControllableHashRunner() {
    let inFlight = 0;
    let maxObservedInFlight = 0;
    const pending: { absolutePath: string; resolve: (hash: string) => void }[] = [];

    const hashRunner: HashRunner = {
      run(absolutePath: string) {
        inFlight++;
        maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
        return new Promise<string>((resolve) => {
          pending.push({
            absolutePath,
            resolve: (hash) => {
              inFlight--;
              resolve(hash);
            },
          });
        });
      },
    };

    return {
      hashRunner,
      get maxObservedInFlight() {
        return maxObservedInFlight;
      },
      get inFlight() {
        return inFlight;
      },
      resolveOldestFirst(hashFor: (absolutePath: string) => string) {
        const job = pending.shift();
        if (!job) throw new Error("no pending hash job to resolve");
        job.resolve(hashFor(job.absolutePath));
      },
      resolveNewestFirst(hashFor: (absolutePath: string) => string) {
        const job = pending.pop();
        if (!job) throw new Error("no pending hash job to resolve");
        job.resolve(hashFor(job.absolutePath));
      },
      get pendingCount() {
        return pending.length;
      },
    };
  }

  it("never dispatches more than maxInFlightHashes hash jobs at once", async () => {
    for (let i = 0; i < 6; i++) touch(`f${i}.txt`, `content ${i}`);
    const repo = makeRepo();
    const controllable = makeControllableHashRunner();

    const statsPromise = run(repo, {
      hashRunner: controllable.hashRunner,
      maxInFlightHashes: 2,
    });
    let settled = false;
    void statsPromise.finally(() => {
      settled = true;
    });

    // Confirm concurrency actually reaches the limit *before* resolving
    // anything -- resolving too eagerly (the instant any job is seen
    // pending) would race the second dispatch and artificially cap what
    // this test can observe at 1, even though the real limit is 2.
    await vi.waitFor(() => expect(controllable.pendingCount).toBe(2));
    expect(controllable.maxObservedInFlight).toBe(2);

    // From here, resolve one job per tick (a real macrotask yield, not
    // `await Promise.resolve()` -- the merge-join loop's own filesystem walk
    // is real async I/O, which needs an actual event-loop turn to progress)
    // until the whole run settles. `settled`, not pendingCount, is the
    // loop's exit condition -- the tail end of the batch legitimately has
    // fewer than `limit` jobs pending at once, which would otherwise
    // deadlock a pendingCount-based wait.
    while (!settled) {
      if (controllable.pendingCount > 0) {
        controllable.resolveOldestFirst((absolutePath) => hashBufferHex(Buffer.from(absolutePath)));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const stats = await statsPromise;
    expect(controllable.maxObservedInFlight).toBeLessThanOrEqual(2);
    expect(stats.created).toBe(6);
  });

  it("produces correct, deterministic per-file results regardless of hash-job completion order", async () => {
    touch("a.txt", "content a");
    touch("b.txt", "content b");
    touch("c.txt", "content c");
    const repo = makeRepo();
    const controllable = makeControllableHashRunner();

    const statsPromise = run(repo, {
      hashRunner: controllable.hashRunner,
      maxInFlightHashes: 3,
    });

    // Let all three dispatch, then resolve them newest-first -- the exact
    // reverse of dispatch order -- to prove per-file row correctness doesn't
    // depend on completion order.
    await vi.waitFor(() => expect(controllable.pendingCount).toBe(3));
    while (controllable.pendingCount > 0) {
      controllable.resolveNewestFirst((absolutePath) => hashBufferHex(Buffer.from(absolutePath)));
    }

    const stats = await statsPromise;
    expect(stats.created).toBe(3);
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      const row = repo.get(name);
      const absolutePath = path.join(root, name);
      expect(row?.hash).toBe(hashBufferHex(Buffer.from(absolutePath)));
    }
  });

  it("propagates a hash job's rejection as a real command failure", async () => {
    touch("good.txt", "fine");
    touch("bad.txt", "also fine on disk, but the hash runner will fail it");
    const repo = makeRepo();
    const hashRunner: HashRunner = {
      run(absolutePath: string) {
        if (absolutePath.endsWith("bad.txt")) {
          return Promise.reject(new Error("simulated ENOENT"));
        }
        return hashFile(absolutePath);
      },
    };

    await expect(run(repo, { hashRunner, maxInFlightHashes: 4 })).rejects.toThrow(
      "simulated ENOENT",
    );
  });
});

describe("performUpdateCache: byte progress", () => {
  it("grows bytesTotal on dispatch, and only advances bytesDone once the hash resolves", async () => {
    touch("a.txt", "hello"); // 5 bytes
    const repo = makeRepo();

    let resolveHash!: (hash: string) => void;
    const hashRunner: HashRunner = {
      run: () => new Promise<string>((resolve) => (resolveHash = resolve)),
    };

    const updates: {
      filesDone: number;
      filesTotal: number;
      bytesDone: number;
      bytesTotal: number;
    }[] = [];
    const statsPromise = run(repo, {
      hashRunner,
      maxInFlightHashes: 4,
      onProgress: (u) => updates.push({ ...u }),
    });

    // Dispatch happens synchronously within the merge-join tick, before the
    // hash job's own promise ever settles -- bytesTotal reflects the file's
    // size immediately, bytesDone stays 0 until resolveHash() is called.
    await vi.waitFor(() => expect(resolveHash).toBeDefined());
    expect(updates.some((u) => u.bytesTotal === 5 && u.bytesDone === 0)).toBe(true);
    expect(updates.every((u) => u.bytesDone === 0)).toBe(true);
    // The discovered/resolved split's own regression test: rowDiscovered()
    // fires as soon as the merge-join reaches this row, but rowResolved()
    // is deferred until the hash job actually settles -- while it's still
    // pending, filesTotal has counted this row and filesDone hasn't.
    expect(updates.some((u) => u.filesTotal > u.filesDone)).toBe(true);

    resolveHash(hashBufferHex(Buffer.from("hello")));
    const stats = await statsPromise;

    expect(stats.created).toBe(1);
    expect(updates.at(-1)).toMatchObject({
      bytesDone: 5,
      bytesTotal: 5,
      filesDone: 1,
      filesTotal: 1,
    });
  });

  it("a directory contributes 0 bytes", async () => {
    fs.mkdirSync(path.join(root, "a-dir"));
    const repo = makeRepo();

    const updates: { bytesDone: number; bytesTotal: number }[] = [];
    const stats = await run(repo, { onProgress: (u) => updates.push({ ...u }) });

    expect(stats.created).toBe(1);
    expect(updates.every((u) => u.bytesDone === 0 && u.bytesTotal === 0)).toBe(true);
  });

  it("an already-resolved stub contributes 0 bytes (never hashed)", async () => {
    const knownHash = hashBufferHex(Buffer.from("stub content"));
    objectsRepo.upsert({ hash: knownHash, s3_key: `objects/${knownHash}`, size: 12 });
    writeStubAtomic(path.join(root, "img.jpg.stub"), knownHash);
    const repo = makeRepo();

    const updates: { bytesDone: number; bytesTotal: number }[] = [];
    const stats = await run(repo, { onProgress: (u) => updates.push({ ...u }) });

    expect(stats.created).toBe(1);
    expect(repo.get("img.jpg")?.size).toBe(12); // the referenced object's size, not the stub file's own
    expect(updates.every((u) => u.bytesDone === 0 && u.bytesTotal === 0)).toBe(true);
  });
});
