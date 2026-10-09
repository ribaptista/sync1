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
import { writeStubAtomic } from "../../../src/fs/stub.js";
import {
  performSanityCheck,
  type ObjectHeadChecker,
  type LocalReader,
  type SanityCheckResult,
} from "../../../src/fs/sanity-check.js";
import type { OnProgress } from "../../../src/progress-types.js";

const silentLogger = {
  debug: () => {},
  warn: () => {},
} as unknown as import("../../../src/logger.js").Logger;

/** A fake ciphertext checksum, deterministic in the content hash -- stands in for the real (convergent) one. */
function crcFor(hash: string): string {
  return `crc:${hash}`;
}

let root: string;
let dbDir: string;
let dbPath: string;
let entriesRepo: EntriesRepository;
let objectsRepo: ObjectsRepository;
let ignorePoliciesRepo: IgnorePoliciesRepository;
/** S3 key -> its checksum, or undefined for "object exists but S3 reports no checksum". Absent key = missing. */
let s3Objects: Map<string, string | undefined>;

const defaultHeadChecker: ObjectHeadChecker = (s3Key) => {
  if (!s3Objects.has(s3Key)) return Promise.resolve(null);
  const checksum = s3Objects.get(s3Key);
  return Promise.resolve(checksum === undefined ? {} : { checksumCrc64Nvme: checksum });
};

/** Reads the file for real (so a genuine I/O error surfaces like the real one would), checksums its content hash. */
const defaultReadLocal: LocalReader = (absolutePath, _size, _hash, onBytes) => {
  const content = fs.readFileSync(absolutePath);
  onBytes(content.length);
  const plaintextHash = hashBufferHex(content);
  return Promise.resolve({ plaintextHash, ciphertextChecksum: crcFor(plaintextHash) });
};

function run(
  headChecker: ObjectHeadChecker,
  filterGlob?: string,
  options: {
    readLocal?: LocalReader;
    onProgress?: OnProgress;
    streamPool?: PQueue;
    streamQueueLimit?: number;
  } = {},
): Promise<SanityCheckResult> {
  return performSanityCheck(
    root,
    entriesRepo,
    objectsRepo,
    ignorePoliciesRepo,
    headChecker,
    options.readLocal ?? defaultReadLocal,
    silentLogger,
    options.streamPool ?? new PQueue({ concurrency: 4 }),
    options.streamQueueLimit ?? 8,
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
  s3Objects = new Map();

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

/** `present=true` also records a checksum matching the hash's own default, so a clean file never mismatches. */
function seedObject(
  hash: string,
  s3Key: string,
  size: number,
  present = true,
  checksum: string = crcFor(hash),
): void {
  objectsRepo.upsert({ hash, s3_key: s3Key, size, ciphertext_checksum: checksum });
  if (present) s3Objects.set(s3Key, checksum);
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

    const result = await run(defaultHeadChecker);
    expect(result).toEqual({
      bothStubAndReal: [],
      hashMismatch: [],
      stubMismatch: [],
      missingInS3: [],
      checksumMismatch: [],
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

    const result = await run(defaultHeadChecker);
    expect(result.untracked).toEqual([]); // never a tracked-content candidate
    expect(result.staleTempFiles).toEqual([
      { path: `.sync1-tmp-${"f0e1d2c3".repeat(4)}`, size: 30 },
    ]);
  });

  it("does not check directories any further once both sides agree they exist", async () => {
    fs.mkdirSync(path.join(root, "photos"));
    seedEntry("photos", null, "dir");

    const result = await run(defaultHeadChecker);
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

    const result = await run(defaultHeadChecker);
    expect(result.bothStubAndReal).toEqual(["img.jpg"]);
    expect(result.missingInS3).toEqual([]);
    expect(result.hashMismatch).toEqual([]);
  });

  it("reports hashMismatch when a real file's content no longer matches state.db, and never HEADs it", async () => {
    const originalHash = hashBufferHex(Buffer.from("original"));
    touch("a.txt", "tampered");
    seedObject(originalHash, "objects/a", 8);
    seedEntry("a.txt", originalHash);
    const headChecker = vi.fn(defaultHeadChecker);

    const result = await run(headChecker);
    expect(result.hashMismatch).toEqual([
      {
        path: "a.txt",
        expectedHash: originalHash,
        actualHash: hashBufferHex(Buffer.from("tampered")),
      },
    ]);
    expect(result.checksumMismatch).toEqual([]);
    expect(result.missingInS3).toEqual([]);
    expect(headChecker).not.toHaveBeenCalled();
  });

  it("reports stubMismatch for a malformed stub", async () => {
    const hash = "d".repeat(64);
    fs.writeFileSync(path.join(root, "bad.jpg.stub"), "not-a-valid-tagged-hash");
    seedObject(hash, "objects/bad", 1);
    seedEntry("bad.jpg", hash);

    const result = await run(defaultHeadChecker);
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

    const result = await run(defaultHeadChecker);
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

    const result = await run(defaultHeadChecker);
    expect(result.missingInS3).toEqual([{ path: "a.txt", hash }]);
    expect(result.checksumMismatch).toEqual([]);
  });

  it("reports missingLocally for a tracked entry with no local presence at all", async () => {
    const hash = hashBufferHex(Buffer.from("gone"));
    seedObject(hash, "objects/gone", 4);
    seedEntry("gone.txt", hash);

    const result = await run(defaultHeadChecker);
    expect(result.missingLocally).toEqual(["gone.txt"]);
  });

  it("reports untracked for a local file with no state.db entry and no ignore match", async () => {
    touch("stray.txt", "surprise");

    const result = await run(defaultHeadChecker);
    expect(result.untracked).toEqual(["stray.txt"]);
    expect(result.ignoredCount).toBe(0);
  });

  it("counts, but does not report as untracked, a local file matching an ignore policy", async () => {
    ignorePoliciesRepo.create("*.tmp");
    touch("scratch.tmp", "throwaway");
    touch("stray.txt", "surprise");

    const result = await run(defaultHeadChecker);
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

    const result = await run(defaultHeadChecker, "keep/*");
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

    const result = await run(defaultHeadChecker);
    expect(result.stubMismatch).toEqual([]);
    expect(result.missingInS3).toEqual([]);
    expect(result.checksumMismatch).toEqual([]);
    // sanity: formatTaggedHash round-trips through writeStubAtomic/readStubHash
    expect(formatTaggedHash(hash)).toMatch(/^blake2b:/);
  });

  it("falls back to a plain hash-only read, never calling readLocal, when an entry has no recorded hash", async () => {
    touch("edge.txt", "unusual, but tolerated");
    seedEntry("edge.txt", null);
    const readLocal = vi.fn(defaultReadLocal);

    const result = await run(defaultHeadChecker, undefined, { readLocal });
    expect(result).toMatchObject({
      hashMismatch: [],
      missingInS3: [],
      checksumMismatch: [],
      untracked: [],
      missingLocally: [],
    });
    expect(readLocal).not.toHaveBeenCalled();
  });

  describe("checksum comparison (local re-encrypt / state.db / S3 HEAD)", () => {
    it("reports checksumMismatch when S3's checksum differs from state.db's recorded one", async () => {
      const hash = hashBufferHex(Buffer.from("hello"));
      touch("a.txt", "hello");
      seedObject(hash, "objects/a", 5); // s3Objects now has crcFor(hash)
      s3Objects.set("objects/a", "crc:drifted"); // ...until S3 drifts from it
      seedEntry("a.txt", hash);

      const result = await run(defaultHeadChecker);
      expect(result.checksumMismatch).toEqual([
        {
          path: "a.txt",
          hash,
          localChecksum: crcFor(hash), // the local file still re-encrypts to its own content
          recordedChecksum: crcFor(hash),
          s3Checksum: "crc:drifted",
        },
      ]);
    });

    it("reports a null s3Checksum when S3 has none recorded for the object", async () => {
      const hash = hashBufferHex(Buffer.from("hello"));
      touch("a.txt", "hello");
      seedObject(hash, "objects/a", 5);
      s3Objects.set("objects/a", undefined); // object exists, but with no checksum
      seedEntry("a.txt", hash);

      const result = await run(defaultHeadChecker);
      expect(result.checksumMismatch).toEqual([
        {
          path: "a.txt",
          hash,
          localChecksum: crcFor(hash),
          recordedChecksum: crcFor(hash),
          s3Checksum: null,
        },
      ]);
    });

    it("reports checksumMismatch when the local re-encrypt disagrees with both state.db and S3", async () => {
      const content = Buffer.from("hello");
      const hash = hashBufferHex(content);
      touch("a.txt", content.toString());
      seedObject(hash, "objects/a", 5); // state.db and S3 agree with each other
      seedEntry("a.txt", hash);
      // The local file's plaintext still hashes correctly (so it clears the
      // hash_mismatch gate), but its ciphertext checksum disagrees --
      // exercised directly, since reproducing it with real encryption would
      // need a tampered *ciphertext*, which never happens through this path.
      const readLocal: LocalReader = () =>
        Promise.resolve({ plaintextHash: hash, ciphertextChecksum: "crc:locally-different" });

      const result = await run(defaultHeadChecker, undefined, { readLocal });
      expect(result.checksumMismatch).toEqual([
        {
          path: "a.txt",
          hash,
          localChecksum: "crc:locally-different",
          recordedChecksum: crcFor(hash),
          s3Checksum: crcFor(hash),
        },
      ]);
    });

    it("checks a stub's checksum against S3, but never calls readLocal (there's no local plaintext)", async () => {
      const hash = hashBufferHex(Buffer.from("steady content"));
      writeStubAtomic(path.join(root, "img.jpg.stub"), hash);
      seedObject(hash, "objects/img", 14);
      s3Objects.set("objects/img", "crc:drifted");
      seedEntry("img.jpg", hash);
      const readLocal = vi.fn(defaultReadLocal);

      const result = await run(defaultHeadChecker, undefined, { readLocal });
      expect(result.checksumMismatch).toEqual([
        {
          path: "img.jpg",
          hash,
          localChecksum: null,
          recordedChecksum: crcFor(hash),
          s3Checksum: "crc:drifted",
        },
      ]);
      expect(readLocal).not.toHaveBeenCalled();
    });
  });
});

describe("performSanityCheck: concurrency and error propagation", () => {
  function makeControllableReadLocal() {
    const pending: {
      path: string;
      hash: string;
      resolve: (r: { plaintextHash: string; ciphertextChecksum: string }) => void;
      reject: (err: unknown) => void;
    }[] = [];

    const readLocal: LocalReader = (absolutePath, _size, hash) =>
      new Promise((resolve, reject) => {
        pending.push({ path: absolutePath, hash, resolve, reject });
      });

    return {
      readLocal,
      get pendingCount() {
        return pending.length;
      },
      resolveOldestFirst(
        result: (hash: string) => { plaintextHash: string; ciphertextChecksum: string },
      ) {
        const job = pending.shift();
        if (!job) throw new Error("no pending job to resolve");
        job.resolve(result(job.hash));
      },
      resolveNewestFirst(
        result: (hash: string) => { plaintextHash: string; ciphertextChecksum: string },
      ) {
        const job = pending.pop();
        if (!job) throw new Error("no pending job to resolve");
        job.resolve(result(job.hash));
      },
    };
  }

  it("still reports a checksum check dispatched by a late-completing read job (join-order correctness)", async () => {
    // Every read job resolves out of merge-join order (reversed), and every
    // one of them is missing in S3 -- proving streamPool.onIdle() draining
    // *before* s3Pool.onIdle() actually catches every read-triggered HEAD
    // dispatch, not just the ones that happened to enqueue early.
    const paths = ["a.txt", "b.txt", "c.txt"];
    for (const p of paths) {
      const hash = hashBufferHex(Buffer.from(p));
      touch(p, p);
      seedObject(hash, `objects/${p}`, p.length, false); // present=false -- every one missing in S3
      seedEntry(p, hash);
    }

    const controllable = makeControllableReadLocal();
    const resultPromise = run(defaultHeadChecker, undefined, { readLocal: controllable.readLocal });

    await vi.waitFor(() => expect(controllable.pendingCount).toBe(3));
    // Resolve newest-first (the reverse of dispatch order), each with its
    // own file's correct hash so entry.hash matches and every one reaches
    // the HEAD check -- proving out-of-order read completion doesn't lose
    // any of the HEAD dispatches it triggers.
    while (controllable.pendingCount > 0) {
      controllable.resolveNewestFirst((hash) => ({
        plaintextHash: hash,
        ciphertextChecksum: crcFor(hash),
      }));
    }

    const result = await resultPromise;
    expect(result.missingInS3.map((m) => m.path).sort()).toEqual(paths);
  });

  it("propagates a rejection from the stream pool, failing the whole check", async () => {
    const hash = hashBufferHex(Buffer.from("hello"));
    touch("a.txt", "hello");
    seedObject(hash, "objects/a", 5);
    seedEntry("a.txt", hash);
    const readLocal: LocalReader = () => Promise.reject(new Error("disk read failed: EIO"));

    await expect(run(defaultHeadChecker, undefined, { readLocal })).rejects.toThrow(
      "disk read failed: EIO",
    );
  });

  it("propagates a rejection from the s3 pool, failing the whole check", async () => {
    const hash = hashBufferHex(Buffer.from("hello"));
    touch("a.txt", "hello");
    seedObject(hash, "objects/a", 5);
    seedEntry("a.txt", hash);
    const headChecker: ObjectHeadChecker = () => Promise.reject(new Error("HEAD failed: 500"));

    await expect(run(headChecker)).rejects.toThrow("HEAD failed: 500");
  });
});

describe("performSanityCheck: byte progress", () => {
  it("grows bytesTotal on dispatch, and only advances bytesDone once the read resolves", async () => {
    const hash = hashBufferHex(Buffer.from("hello")); // 5 bytes
    touch("a.txt", "hello");
    seedObject(hash, "objects/a", 5);
    seedEntry("a.txt", hash);

    let resolveRead!: (r: { plaintextHash: string; ciphertextChecksum: string }) => void;
    const readLocal: LocalReader = () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      });

    const updates: {
      filesDone: number;
      filesTotal: number;
      bytesDone: number;
      bytesTotal: number;
    }[] = [];
    const resultPromise = run(defaultHeadChecker, undefined, {
      readLocal,
      onProgress: (u) => updates.push({ ...u }),
    });

    await vi.waitFor(() => expect(resolveRead).toBeDefined());
    expect(updates.some((u) => u.bytesTotal === 5 && u.bytesDone === 0)).toBe(true);
    expect(updates.every((u) => u.bytesDone === 0)).toBe(true);

    resolveRead({ plaintextHash: hash, ciphertextChecksum: crcFor(hash) });
    await resultPromise;

    expect(updates.at(-1)).toMatchObject({ bytesDone: 5, bytesTotal: 5 });
  });

  it("a directory contributes 0 bytes", async () => {
    fs.mkdirSync(path.join(root, "photos"));
    seedEntry("photos", null, "dir");

    const updates: { bytesDone: number; bytesTotal: number }[] = [];
    await run(defaultHeadChecker, undefined, { onProgress: (u) => updates.push({ ...u }) });

    expect(updates.every((u) => u.bytesDone === 0 && u.bytesTotal === 0)).toBe(true);
  });

  it("a stub contributes 0 bytes (its declared hash is read synchronously, never re-encrypted)", async () => {
    const hash = hashBufferHex(Buffer.from("steady content"));
    writeStubAtomic(path.join(root, "img.jpg.stub"), hash);
    seedObject(hash, "objects/img", 14);
    seedEntry("img.jpg", hash);

    const updates: { bytesDone: number; bytesTotal: number }[] = [];
    await run(defaultHeadChecker, undefined, { onProgress: (u) => updates.push({ ...u }) });

    expect(updates.every((u) => u.bytesDone === 0 && u.bytesTotal === 0)).toBe(true);
  });

  it("knows the whole byte total while the stream pool is still blocking the merge-join", async () => {
    // The regression the enumeration pass exists to prevent. Three tracked
    // files, a stream pool of one, and a reader that never resolves until
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
    const readLocal: LocalReader = async (absolutePath, _size, hash, onBytes) => {
      await gate;
      const content = fs.readFileSync(absolutePath);
      onBytes(content.length);
      return { plaintextHash: hash, ciphertextChecksum: crcFor(hash) };
    };

    const updates: { bytesDone: number; bytesTotal: number; filesTotal: number }[] = [];
    const resultPromise = run(defaultHeadChecker, undefined, {
      readLocal,
      streamPool: new PQueue({ concurrency: 1 }),
      streamQueueLimit: 1,
      onProgress: (u) => updates.push({ ...u }),
    });

    await vi.waitFor(() => {
      expect(updates.some((u) => u.bytesTotal === 700)).toBe(true);
    });
    // Nothing has finished reading: the total came from the enumeration
    // pass running ahead of the blocked merge-join, not from dispatch,
    // which by now has only ever seen a.txt's 100 bytes.
    expect(updates.every((u) => u.bytesDone === 0)).toBe(true);

    openGate();
    const result = await resultPromise;
    expect(result.hashMismatch).toEqual([]);
    expect(result.missingInS3).toEqual([]);
    expect(result.checksumMismatch).toEqual([]);

    const last = updates.at(-1)!;
    expect(last.bytesDone).toBe(700);
    expect(last.bytesTotal).toBe(700);
  });

  it("counts only the --filter's scope, not the whole tree it still has to walk", async () => {
    // The merge-join always walks everything (it can't tell "filtered out"
    // from "genuinely missing" otherwise), but only in-scope paths are
    // ever read -- so only those may show up in the byte total.
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
    await run(defaultHeadChecker, "keep/**", { onProgress: (u) => updates.push({ ...u }) });

    expect(updates.every((u) => u.bytesTotal <= 100)).toBe(true);
    expect(updates.at(-1)).toMatchObject({ bytesDone: 100, bytesTotal: 100 });
  });
});
