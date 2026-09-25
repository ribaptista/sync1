import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import PQueue from "p-queue";
import { openStateDb } from "../../../src/db/connection.js";
import { EntriesRepository } from "../../../src/db/repositories/entries-repository.js";
import { ObjectsRepository } from "../../../src/db/repositories/objects-repository.js";
import { IgnorePoliciesRepository } from "../../../src/db/repositories/ignore-policies-repository.js";
import { VersionsRepository } from "../../../src/db/repositories/versions-repository.js";
import { hashBufferHex, formatTaggedHash } from "../../../src/crypto/hash.js";
import { hashFile } from "../../../src/fs/hash-file.js";
import { writeStubAtomic } from "../../../src/fs/stub.js";
import {
  performSanityCheck,
  type ObjectExistsChecker,
  type SanityCheckResult,
} from "../../../src/fs/sanity-check.js";
import type { HashRunner } from "../../../src/concurrency/hash-runner.js";
import type { OnProgress } from "../../../src/progress-types.js";

const silentLogger = {
  debug: () => {},
  warn: () => {},
} as unknown as import("../../../src/logger.js").Logger;

// Most tests below only care about *whether/what* gets reported, not the
// concurrency mechanics -- this default HashRunner just delegates to the
// real (small, fast) hashFile, and a generous pool limit means nothing in
// these tests ever hits backpressure. Dedicated concurrency tests inject
// their own controllable fake instead, per the same pattern used in
// update-cache.test.ts.
const defaultHashRunner: HashRunner = { run: (absolutePath) => hashFile(absolutePath) };

let root: string;
let dbDir: string;
let dbPath: string;
let entriesRepo: EntriesRepository;
let objectsRepo: ObjectsRepository;
let ignorePoliciesRepo: IgnorePoliciesRepository;
let existingS3Keys: Set<string>;

const alwaysExists: ObjectExistsChecker = (s3Key) => Promise.resolve(existingS3Keys.has(s3Key));

function run(
  objectExists: ObjectExistsChecker,
  filterGlob?: string,
  options: {
    hashRunner?: HashRunner;
    onProgress?: OnProgress;
    maxInFlightHashes?: number;
  } = {},
): Promise<SanityCheckResult> {
  return performSanityCheck(
    root,
    entriesRepo,
    objectsRepo,
    ignorePoliciesRepo,
    objectExists,
    silentLogger,
    options.hashRunner ?? defaultHashRunner,
    options.maxInFlightHashes ?? 4,
    new PQueue({ concurrency: 4 }),
    8,
    filterGlob,
    options.onProgress,
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-sanity-check-test-"));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-sanity-check-db-"));
  dbPath = path.join(dbDir, "state.db");
  existingS3Keys = new Set();

  // One connection, exactly like the CLI command does -- entriesRepo's
  // iterateAllSortedByPath() is keyset-paginated, not a live `.iterate()`
  // cursor, so objectsRepo/ignorePoliciesRepo can safely share it.
  const db = openStateDb(dbPath);
  new VersionsRepository(db).insert("v0", new Date().toISOString());
  entriesRepo = new EntriesRepository(db);
  objectsRepo = new ObjectsRepository(db);
  ignorePoliciesRepo = new IgnorePoliciesRepository(db);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

function touch(relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function seedObject(hash: string, s3Key: string, size: number, present = true): void {
  objectsRepo.upsert({ hash, s3_key: s3Key, size });
  if (present) existingS3Keys.add(s3Key);
}

function seedEntry(filePath: string, hash: string | null, type: "file" | "dir" = "file"): void {
  entriesRepo.upsert({ path: filePath, type, hash, state_version: "v0" });
}

describe("performSanityCheck", () => {
  it("reports no problems for a fully clean, in-sync file", async () => {
    const hash = hashBufferHex(Buffer.from("hello"));
    touch("a.txt", "hello");
    seedObject(hash, "objects/a", 5);
    seedEntry("a.txt", hash);

    const result = await run(alwaysExists);
    expect(result).toEqual({
      bothStubAndReal: [],
      hashMismatch: [],
      stubMismatch: [],
      missingInS3: [],
      missingLocally: [],
      untracked: [],
      ignoredCount: 0,
      staleTempFiles: [],
    });
  });

  /**
   * These are invisible everywhere else: the startup sweep reads only
   * `.sync1/`, and every walk excludes them by name, so nothing reports or
   * removes them and a partially-decrypted `materialize` temp can sit
   * there indefinitely. Reported with a size, never deleted -- this
   * command is read-only.
   */
  it("reports an in-tree temp left by an interrupted run, without mistaking it for untracked content", async () => {
    const hash = hashBufferHex(Buffer.from("hello"));
    touch("a.txt", "hello");
    seedObject(hash, "objects/a", 5);
    seedEntry("a.txt", hash);
    touch(`.sync1-tmp-${"f0e1d2c3".repeat(4)}`, "half-downloaded, never renamed");

    const result = await run(alwaysExists);
    expect(result.untracked).toEqual([]); // never a tracked-content candidate
    expect(result.staleTempFiles).toEqual([
      { path: `.sync1-tmp-${"f0e1d2c3".repeat(4)}`, size: 30 },
    ]);
  });

  it("does not check directories any further once both sides agree they exist", async () => {
    fs.mkdirSync(path.join(root, "photos"));
    seedEntry("photos", null, "dir");

    const result = await run(alwaysExists);
    expect(result.missingLocally).toEqual([]);
    expect(result.untracked).toEqual([]);
  });

  it("reports bothStubAndReal when a stub and the real file coexist, without further checks", async () => {
    const hash = hashBufferHex(Buffer.from("real content"));
    touch("img.jpg", "real content");
    writeStubAtomic(path.join(root, "img.jpg.stub"), "c".repeat(64)); // bogus hash, deliberately
    seedObject(hash, "objects/img", 12, false); // present=false -- if this were checked
    // further it would also show up as missingInS3; it must not be, since
    // "both" short-circuits before the S3 check.
    seedEntry("img.jpg", hash);

    const result = await run(alwaysExists);
    expect(result.bothStubAndReal).toEqual(["img.jpg"]);
    expect(result.missingInS3).toEqual([]);
    expect(result.hashMismatch).toEqual([]);
  });

  it("reports hashMismatch when a real file's content no longer matches state.db", async () => {
    const originalHash = hashBufferHex(Buffer.from("original"));
    touch("a.txt", "tampered");
    seedObject(originalHash, "objects/a", 8);
    seedEntry("a.txt", originalHash);

    const result = await run(alwaysExists);
    expect(result.hashMismatch).toEqual([
      {
        path: "a.txt",
        expectedHash: originalHash,
        actualHash: hashBufferHex(Buffer.from("tampered")),
      },
    ]);
  });

  it("reports stubMismatch for a malformed stub", async () => {
    const hash = "d".repeat(64);
    fs.writeFileSync(path.join(root, "bad.jpg.stub"), "not-a-valid-tagged-hash");
    seedObject(hash, "objects/bad", 1);
    seedEntry("bad.jpg", hash);

    const result = await run(alwaysExists);
    expect(result.stubMismatch).toHaveLength(1);
    expect(result.stubMismatch[0]!.path).toBe("bad.jpg");
    expect(result.stubMismatch[0]!.reason).toMatch(/malformed stub content/);
  });

  it("reports stubMismatch when a valid stub declares a hash different from state.db's", async () => {
    const declaredHash = "a".repeat(64);
    const expectedHash = "b".repeat(64);
    writeStubAtomic(path.join(root, "img.jpg.stub"), declaredHash);
    seedObject(expectedHash, "objects/img", 1);
    seedEntry("img.jpg", expectedHash);

    const result = await run(alwaysExists);
    expect(result.stubMismatch).toEqual([
      {
        path: "img.jpg",
        reason: `stub declares hash ${declaredHash}, state.db expects ${expectedHash}`,
      },
    ]);
  });

  it("reports missingInS3 when the object row exists but the S3 object itself doesn't", async () => {
    const hash = hashBufferHex(Buffer.from("hello"));
    touch("a.txt", "hello");
    seedObject(hash, "objects/a", 5, false); // present=false: row exists, S3 object doesn't
    seedEntry("a.txt", hash);

    const result = await run(alwaysExists);
    expect(result.missingInS3).toEqual([{ path: "a.txt", hash }]);
  });

  it("reports missingLocally for a tracked entry with no local presence at all", async () => {
    const hash = hashBufferHex(Buffer.from("gone"));
    seedObject(hash, "objects/gone", 4);
    seedEntry("gone.txt", hash);

    const result = await run(alwaysExists);
    expect(result.missingLocally).toEqual(["gone.txt"]);
  });

  it("reports untracked for a local file with no state.db entry and no ignore match", async () => {
    touch("stray.txt", "surprise");

    const result = await run(alwaysExists);
    expect(result.untracked).toEqual(["stray.txt"]);
    expect(result.ignoredCount).toBe(0);
  });

  it("counts, but does not report as untracked, a local file matching an ignore policy", async () => {
    ignorePoliciesRepo.create("*.tmp");
    touch("scratch.tmp", "throwaway");
    touch("stray.txt", "surprise");

    const result = await run(alwaysExists);
    expect(result.untracked).toEqual(["stray.txt"]);
    expect(result.ignoredCount).toBe(1);
  });

  it("scopes reporting to --filter, without misclassifying out-of-scope paths", async () => {
    const hash = hashBufferHex(Buffer.from("hello"));
    touch("keep/a.txt", "hello");
    seedObject(hash, "objects/a", 5);
    seedEntry("keep/a.txt", hash);
    const goneHash = hashBufferHex(Buffer.from("gone"));
    seedObject(goneHash, "objects/gone", 4);
    seedEntry("elsewhere/gone.txt", goneHash); // out of scope
    touch("elsewhere/stray.txt", "surprise"); // out of scope

    const result = await run(alwaysExists, "keep/*");
    expect(result.missingLocally).toEqual([]);
    expect(result.untracked).toEqual([]);
    expect(result.hashMismatch).toEqual([]);
    expect(result.missingInS3).toEqual([]);
  });

  it("uses the tagged-hash format sanity check helper correctly for a happy-path stub", async () => {
    const hash = hashBufferHex(Buffer.from("steady content"));
    writeStubAtomic(path.join(root, "img.jpg.stub"), hash);
    seedObject(hash, "objects/img", 14);
    seedEntry("img.jpg", hash);

    const result = await run(alwaysExists);
    expect(result.stubMismatch).toEqual([]);
    expect(result.missingInS3).toEqual([]);
    // sanity: formatTaggedHash round-trips through writeStubAtomic/readStubHash
    expect(formatTaggedHash(hash)).toMatch(/^blake2b:/);
  });
});

describe("performSanityCheck: concurrency", () => {
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
      get pendingCount() {
        return pending.length;
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
    };
  }

  it("never dispatches more than maxInFlightHashes hash jobs at once", async () => {
    for (let i = 0; i < 6; i++) {
      const hash = hashBufferHex(Buffer.from(`content ${i}`));
      touch(`f${i}.txt`, `content ${i}`);
      seedObject(hash, `objects/f${i}`, 20);
      seedEntry(`f${i}.txt`, hash);
    }
    const controllable = makeControllableHashRunner();

    const resultPromise = performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      alwaysExists,
      silentLogger,
      controllable.hashRunner,
      2,
      new PQueue({ concurrency: 4 }),
      8,
    );
    let settled = false;
    void resultPromise.finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(controllable.pendingCount).toBe(2));
    expect(controllable.maxObservedInFlight).toBe(2);

    while (!settled) {
      if (controllable.pendingCount > 0) {
        controllable.resolveOldestFirst((absolutePath) =>
          hashBufferHex(Buffer.from(`content ${path.basename(absolutePath).replace(/\D/g, "")}`)),
        );
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await resultPromise;
    expect(controllable.maxObservedInFlight).toBeLessThanOrEqual(2);
  });

  it("still reports an S3 check dispatched by a late-completing hash job (join-order correctness)", async () => {
    // Every hash job resolves out of merge-join order (reversed), and every
    // one of them is missing in S3 -- proving hashJobs.onIdle() draining
    // *before* s3Pool.onIdle() actually catches every hash-triggered S3
    // dispatch, not just the ones that happened to enqueue early.
    const paths = ["a.txt", "b.txt", "c.txt"];
    for (const p of paths) {
      const hash = hashBufferHex(Buffer.from(p));
      touch(p, p);
      seedObject(hash, `objects/${p}`, p.length, false); // present=false -- every one missing in S3
      seedEntry(p, hash);
    }

    const controllable = makeControllableHashRunner();
    const resultPromise = performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      alwaysExists,
      silentLogger,
      controllable.hashRunner,
      3,
      new PQueue({ concurrency: 4 }),
      8,
    );

    await vi.waitFor(() => expect(controllable.pendingCount).toBe(3));
    // Resolve newest-first (the reverse of dispatch order), each with its
    // own file's content hash so entry.hash matches and every one reaches
    // the S3 check -- proving out-of-order hash completion doesn't lose any
    // of the S3 dispatches it triggers.
    while (controllable.pendingCount > 0) {
      controllable.resolveNewestFirst((absolutePath) =>
        hashBufferHex(Buffer.from(path.basename(absolutePath))),
      );
    }

    const result = await resultPromise;
    expect(result.missingInS3.map((m) => m.path).sort()).toEqual(paths);
  });
});

describe("performSanityCheck: byte progress", () => {
  it("grows bytesTotal on dispatch, and only advances bytesDone once the hash resolves", async () => {
    const hash = hashBufferHex(Buffer.from("hello")); // 5 bytes
    touch("a.txt", "hello");
    seedObject(hash, "objects/a", 5);
    seedEntry("a.txt", hash);

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
    const resultPromise = run(alwaysExists, undefined, {
      hashRunner,
      onProgress: (u) => updates.push({ ...u }),
    });

    await vi.waitFor(() => expect(resolveHash).toBeDefined());
    expect(updates.some((u) => u.bytesTotal === 5 && u.bytesDone === 0)).toBe(true);
    expect(updates.every((u) => u.bytesDone === 0)).toBe(true);

    resolveHash(hash);
    await resultPromise;

    expect(updates.at(-1)).toMatchObject({ bytesDone: 5, bytesTotal: 5 });
  });

  it("a directory contributes 0 bytes", async () => {
    fs.mkdirSync(path.join(root, "photos"));
    seedEntry("photos", null, "dir");

    const updates: { bytesDone: number; bytesTotal: number }[] = [];
    await run(alwaysExists, undefined, { onProgress: (u) => updates.push({ ...u }) });

    expect(updates.every((u) => u.bytesDone === 0 && u.bytesTotal === 0)).toBe(true);
  });

  it("a stub contributes 0 bytes (its declared hash is read synchronously, never hashed)", async () => {
    const hash = hashBufferHex(Buffer.from("steady content"));
    writeStubAtomic(path.join(root, "img.jpg.stub"), hash);
    seedObject(hash, "objects/img", 14);
    seedEntry("img.jpg", hash);

    const updates: { bytesDone: number; bytesTotal: number }[] = [];
    await run(alwaysExists, undefined, { onProgress: (u) => updates.push({ ...u }) });

    expect(updates.every((u) => u.bytesDone === 0 && u.bytesTotal === 0)).toBe(true);
  });

  it("knows the whole byte total while the hash pool is still blocking the merge-join", async () => {
    // The regression the enumeration pass exists to prevent. Three tracked
    // files, a hash pool of one, and a runner that never resolves until
    // the gate opens: the merge-join dispatches the first file and then
    // blocks on the pool. Discovery-driven totals could only ever have
    // seen ONE file's bytes by now.
    for (const [name, content] of [
      ["a.txt", "a".repeat(100)],
      ["b.txt", "b".repeat(200)],
      ["c.txt", "c".repeat(400)],
    ] as const) {
      const hash = hashBufferHex(Buffer.from(content));
      touch(name, content);
      seedObject(hash, `objects/${name}`, content.length);
      seedEntry(name, hash);
    }

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    const hashRunner: HashRunner = {
      run: async (absolutePath) => {
        await gate;
        return hashFile(absolutePath);
      },
    };

    const updates: { bytesDone: number; bytesTotal: number; filesTotal: number }[] = [];
    const resultPromise = run(alwaysExists, undefined, {
      hashRunner,
      maxInFlightHashes: 1,
      onProgress: (u) => updates.push({ ...u }),
    });

    await vi.waitFor(() => {
      expect(updates.some((u) => u.bytesTotal === 700)).toBe(true);
    });
    // Nothing has finished hashing: the total came from the enumeration
    // pass running ahead of the blocked merge-join, not from dispatch,
    // which by now has only ever seen a.txt's 100 bytes.
    expect(updates.every((u) => u.bytesDone === 0)).toBe(true);

    openGate();
    const result = await resultPromise;
    expect(result.hashMismatch).toEqual([]);
    expect(result.missingInS3).toEqual([]);

    const last = updates.at(-1)!;
    expect(last.bytesDone).toBe(700);
    expect(last.bytesTotal).toBe(700);
  });

  it("counts only the --filter's scope, not the whole tree it still has to walk", async () => {
    // The merge-join always walks everything (it can't tell "filtered out"
    // from "genuinely missing" otherwise), but only in-scope paths are
    // ever hashed -- so only those may show up in the byte total.
    for (const [name, content] of [
      ["keep/a.txt", "a".repeat(100)],
      ["other/b.txt", "b".repeat(200)],
    ] as const) {
      const hash = hashBufferHex(Buffer.from(content));
      touch(name, content);
      seedObject(hash, `objects/${name}`, content.length);
      seedEntry(name, hash);
    }

    const updates: { bytesDone: number; bytesTotal: number }[] = [];
    await run(alwaysExists, "keep/**", { onProgress: (u) => updates.push({ ...u }) });

    expect(updates.every((u) => u.bytesTotal <= 100)).toBe(true);
    expect(updates.at(-1)).toMatchObject({ bytesDone: 100, bytesTotal: 100 });
  });
});
