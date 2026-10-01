import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import PQueue from "p-queue";
import { openStateDb } from "../../../src/db/connection.js";
import { EntriesRepository } from "../../../src/db/repositories/entries-repository.js";
import { ObjectsRepository } from "../../../src/db/repositories/objects-repository.js";
import { VersionsRepository } from "../../../src/db/repositories/versions-repository.js";
import { hashBufferHex } from "../../../src/crypto/hash.js";
import { objectKey } from "../../../src/vault/paths.js";
import { StoragePoliciesRepository } from "../../../src/db/repositories/storage-policies-repository.js";
import { MirrorRequiredError } from "../../../src/fs/mirror-sink.js";
import type { ProgressUpdate } from "../../../src/progress-types.js";
import type { UploadObjectStreamOptions } from "../../../src/s3/upload-object.js";

// Drains the body stream, same as a real S3 client would -- otherwise the
// encrypt pipeline never finishes flowing, and the source file read can race
// past a test's own cleanup. Reinstated in every beforeEach below, because
// mockClear() forgets recorded calls but keeps whatever implementation a
// previous test installed (the retry test installs a failing one). Returns
// a fixed fake checksum -- uploadObjectStream's real return value, which
// none of these tests inspect -- so the mock's shape matches the real
// function.
async function drainBody(
  _client: unknown,
  _bucket: unknown,
  _key: unknown,
  body: AsyncIterable<unknown>,
): Promise<string> {
  for await (const _chunk of body) {
    // draining is the point
  }
  return "fake-checksum";
}

// Only `headObject` is replaced -- `MULTIPART_THRESHOLD_BYTES`/
// `multipartPartSize` stay real, since `src/s3/upload-object.js` (mocked
// below, but via `importOriginal` for its own unrelated exports) imports
// them from this same module at load time, and a wholesale replacement
// here would leave that import undefined.
vi.mock("../../../src/s3/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/s3/client.js")>();
  return { ...actual, headObject: vi.fn() };
});

// Only `uploadObjectStream` is replaced -- `S3UploadFatalError` stays the
// real class via `importOriginal`, so `instanceof` checks in
// apply-local-changes.ts (and in this file's own assertions) see the same
// constructor the production code throws.
vi.mock("../../../src/s3/upload-object.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/s3/upload-object.js")>();
  return { ...actual, uploadObjectStream: vi.fn() };
});

const { applyLocalChangesToCandidate } = await import("../../../src/sync/apply-local-changes.js");
const { headObject } = await import("../../../src/s3/client.js");
const { uploadObjectStream, S3UploadFatalError } = await import("../../../src/s3/upload-object.js");
const headObjectMock = vi.mocked(headObject);
const putObjectStreamMock = vi.mocked(uploadObjectStream);

const silentLogger = {
  debug: () => {},
  warn: () => {},
} as unknown as import("../../../src/logger.js").Logger;

// Never actually called: the case-collision check short-circuits before any
// upload would be attempted, for the scenario these tests exercise.
const unusedS3 = {
  client: {} as S3Client,
  bucket: "unused",
  location: { bucket: "unused", prefix: "" },
};

describe("applyLocalChangesToCandidate: case-insensitive collision (sync-time)", () => {
  it("produces a soft conflict (not a thrown error) when a local create collides with an existing entry", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    new ObjectsRepository(candidateDb).upsert({
      hash: "a".repeat(64),
      s3_key: `objects/${"a".repeat(64)}`,
      size: 1,
      ciphertext_checksum: "crc-test",
    });
    new EntriesRepository(candidateDb).upsert({
      path: "photo.jpg",
      type: "file",
      hash: "a".repeat(64),
      state_version: "v0",
    });

    const dirtyRow = {
      path: "Photo.jpg",
      type: "file" as const,
      mtime: 1,
      hash: "b".repeat(64),
      size: 1,
      state: "created" as const,
      parent_state_version: "v0",
    };

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      [dirtyRow],
      "/unused-root",
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
    );

    expect(result.conflicts).toEqual([
      {
        path: "Photo.jpg",
        reason:
          'case-insensitive collision with existing entry "photo.jpg" -- rename or remove one of them and sync again',
      },
    ]);
    expect(result.appliedCount).toBe(0);
    expect(result.handledPaths.size).toBe(0);
    expect(result.uploadedObjects).toBe(0);

    // the candidate's original entry is untouched, and no second entry was added
    const entriesRepo = new EntriesRepository(candidateDb);
    expect(entriesRepo.get("photo.jpg")?.hash).toBe("a".repeat(64));
    expect(entriesRepo.get("Photo.jpg")).toBeUndefined();

    candidateDb.close();
  });

  it("does not flag a collision for a 'modified'/'deleted' row against its own exact-path entry", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    new ObjectsRepository(candidateDb).upsert({
      hash: "a".repeat(64),
      s3_key: `objects/${"a".repeat(64)}`,
      size: 1,
      ciphertext_checksum: "crc-test",
    });
    new EntriesRepository(candidateDb).upsert({
      path: "photo.jpg",
      type: "file",
      hash: "a".repeat(64),
      state_version: "v0",
    });

    const dirtyRow = {
      path: "photo.jpg",
      type: "file" as const,
      mtime: 1,
      hash: "a".repeat(64), // unchanged content -> resolves as a no-op, not a conflict
      size: 1,
      state: "modified" as const,
      parent_state_version: "v0",
    };

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      [dirtyRow],
      "/unused-root",
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
    );

    expect(result.conflicts).toEqual([]);
    expect(result.handledPaths.has("photo.jpg")).toBe(true);

    candidateDb.close();
  });
});

describe("applyLocalChangesToCandidate: reported baseline stamps", () => {
  const HASH = "a".repeat(64);

  function seedCandidate(): import("better-sqlite3").Database {
    const candidateDb = openStateDb(":memory:");
    const versions = new VersionsRepository(candidateDb);
    // "v0" is where this path's entry sits. "v5" stands in for any later
    // commit that never rewrote this path's row -- a policy mutation, or
    // another path's commit.
    versions.insert("v0", new Date().toISOString());
    versions.insert("v5", new Date().toISOString());
    new ObjectsRepository(candidateDb).upsert({
      hash: HASH,
      s3_key: `objects/${HASH}`,
      size: 1,
      ciphertext_checksum: "crc-test",
    });
    new EntriesRepository(candidateDb).upsert({
      path: "photo.jpg",
      type: "file",
      hash: HASH,
      state_version: "v0",
    });
    return candidateDb;
  }

  it("reports a no-op-resolved row at the stamp the vault still holds, not this run's", async () => {
    const candidateDb = seedCandidate();

    const dirtyRow = {
      path: "photo.jpg",
      type: "file" as const,
      mtime: 1,
      // Content matches what the vault already has, but the baseline
      // doesn't ("v5" vs the entry's "v0") -- decideModified's hash
      // fallback resolves this as a no-op, and a no-op writes nothing to
      // `entries`.
      hash: HASH,
      size: 1,
      state: "modified" as const,
      parent_state_version: "v5",
    };

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      [dirtyRow],
      "/unused-root",
      Buffer.alloc(32),
      "v9",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
    );

    expect(result.conflicts).toEqual([]);
    expect(result.appliedCount).toBe(0);
    // The regression this guards: reconciling the cache row to the run's
    // "v9" would leave it claiming a baseline the vault never had (its
    // entry is still at "v0"), so the next local edit or delete of this
    // path would be reported as "modified remotely".
    expect(result.handledPaths.get("photo.jpg")).toBe("v0");

    candidateDb.close();
  });

  it("reports an applied row at this run's stamp -- the one it was just written with", async () => {
    const candidateDb = seedCandidate();

    const dirtyRow = {
      path: "photo.jpg",
      type: "dir" as const, // a dir needs no upload, keeping this test I/O-free
      mtime: 1,
      hash: null,
      size: null,
      state: "modified" as const,
      parent_state_version: "v0", // matches the entry -> fast-forward apply
    };

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      [dirtyRow],
      "/unused-root",
      Buffer.alloc(32),
      "v9",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
    );

    expect(result.appliedCount).toBe(1);
    expect(result.handledPaths.get("photo.jpg")).toBe("v9");
    expect(new EntriesRepository(candidateDb).get("photo.jpg")?.state_version).toBe("v9");

    candidateDb.close();
  });

  it("reports a deleted row as having no vault stamp at all", async () => {
    const candidateDb = seedCandidate();

    const dirtyRow = {
      path: "photo.jpg",
      type: "file" as const,
      mtime: null,
      hash: null,
      size: null,
      state: "deleted" as const,
      parent_state_version: "v0",
    };

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      [dirtyRow],
      "/unused-root",
      Buffer.alloc(32),
      "v9",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
    );

    expect(result.appliedCount).toBe(1);
    // Handled, but with no stamp -- the entry is gone, and reconciliation
    // drops the cache row outright rather than stamping it.
    expect(result.handledPaths.has("photo.jpg")).toBe(true);
    expect(result.handledPaths.get("photo.jpg")).toBeNull();

    candidateDb.close();
  });
});

describe("applyLocalChangesToCandidate: same-batch dedup and collision (Pass 2)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-apply-local-changes-test-"));
    putObjectStreamMock.mockReset();
    putObjectStreamMock.mockImplementation(drainBody);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function touch(relPath: string, content: string, mtime = 1): void {
    const absolute = path.join(root, relPath);
    fs.writeFileSync(absolute, content);
    // The rows below declare `mtime: 1`, and the upload path re-stats the
    // file to confirm it hasn't changed since the scan that hashed it. A
    // fixture whose file and row disagree would be rejected for a reason
    // the test isn't about, so make them agree rather than loosening the
    // check.
    fs.utimesSync(absolute, new Date(mtime), new Date(mtime));
  }

  it("uploads once and attaches a second same-batch row sharing identical content", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    touch("a.txt", "shared content");
    touch("b.txt", "shared content");
    const hash = hashBufferHex(Buffer.from("shared content"));

    const dirtyRows = [
      {
        path: "a.txt",
        type: "file" as const,
        mtime: 1,
        hash,
        size: 14,
        state: "created" as const,
        parent_state_version: "v0",
      },
      {
        path: "b.txt",
        type: "file" as const,
        mtime: 1,
        hash,
        size: 14,
        state: "created" as const,
        parent_state_version: "v0",
      },
    ];

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      dirtyRows,
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
    );

    expect(result.conflicts).toEqual([]);
    expect(result.uploadedObjects).toBe(1);
    expect(result.dedupedObjects).toBe(1);
    expect(putObjectStreamMock).toHaveBeenCalledTimes(1);

    const entriesRepo = new EntriesRepository(candidateDb);
    expect(entriesRepo.get("a.txt")?.hash).toBe(hash);
    expect(entriesRepo.get("b.txt")?.hash).toBe(hash);

    candidateDb.close();
  });

  it("flags a same-batch case-insensitive collision against a still-in-flight upload", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    touch("photo.jpg", "content one");
    touch("Photo.jpg", "content two");

    const dirtyRows = [
      {
        path: "photo.jpg",
        type: "file" as const,
        mtime: 1,
        hash: hashBufferHex(Buffer.from("content one")),
        size: 11,
        state: "created" as const,
        parent_state_version: "v0",
      },
      {
        path: "Photo.jpg",
        type: "file" as const,
        mtime: 1,
        hash: hashBufferHex(Buffer.from("content two")),
        size: 11,
        state: "created" as const,
        parent_state_version: "v0",
      },
    ];

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      dirtyRows,
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
    );

    expect(result.conflicts).toEqual([
      {
        path: "Photo.jpg",
        reason:
          'case-insensitive collision with existing entry "photo.jpg" -- rename or remove one of them and sync again',
      },
    ]);
    // the first (non-colliding) row still applied normally
    const entriesRepo = new EntriesRepository(candidateDb);
    expect(entriesRepo.get("photo.jpg")?.hash).toBe(hashBufferHex(Buffer.from("content one")));
    expect(entriesRepo.get("Photo.jpg")).toBeUndefined();

    candidateDb.close();
  });
});

describe("applyLocalChangesToCandidate: byte progress", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-apply-local-changes-progress-test-"));
    putObjectStreamMock.mockReset();
    putObjectStreamMock.mockImplementation(drainBody);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function touch(relPath: string, content: string, mtime = 1): void {
    const absolute = path.join(root, relPath);
    fs.writeFileSync(absolute, content);
    // The rows below declare `mtime: 1`, and the upload path re-stats the
    // file to confirm it hasn't changed since the scan that hashed it. A
    // fixture whose file and row disagree would be rejected for a reason
    // the test isn't about, so make them agree rather than loosening the
    // check.
    fs.utimesSync(absolute, new Date(mtime), new Date(mtime));
  }

  it("dispatch grows bytesTotal before completion advances bytesDone, for a genuine upload", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const content = "new upload content";
    touch("a.txt", content);
    const hash = hashBufferHex(Buffer.from(content));

    const dirtyRow = {
      path: "a.txt",
      type: "file" as const,
      mtime: 1,
      hash,
      size: content.length,
      state: "created" as const,
      parent_state_version: "v0",
    };

    const updates: ProgressUpdate[] = [];
    const result = await applyLocalChangesToCandidate(
      candidateDb,
      [dirtyRow],
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
      (u) => updates.push(u),
    );

    expect(result.uploadedObjects).toBe(1);
    // some report happened right after dispatch, before the upload settled
    expect(updates.some((u) => u.bytesTotal === content.length && u.bytesDone === 0)).toBe(true);
    // toMatchObject, not toEqual: the last update also carries an `activity`
    // ("uploaded ...") from FileTracker.finish() -- this checks the numeric
    // tally without pinning down that label's exact shape.
    expect(updates[updates.length - 1]).toMatchObject({
      filesDone: 1,
      filesTotal: 1,
      bytesDone: content.length,
      bytesTotal: content.length,
    });

    candidateDb.close();
  });

  it("a same-batch dedup attach contributes 0 bytes but still counts toward filesDone/filesTotal", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    touch("a.txt", "shared content");
    touch("b.txt", "shared content");
    const hash = hashBufferHex(Buffer.from("shared content"));

    const dirtyRows = [
      {
        path: "a.txt",
        type: "file" as const,
        mtime: 1,
        hash,
        size: 14,
        state: "created" as const,
        parent_state_version: "v0",
      },
      {
        path: "b.txt",
        type: "file" as const,
        mtime: 1,
        hash,
        size: 14,
        state: "created" as const,
        parent_state_version: "v0",
      },
    ];

    const updates: ProgressUpdate[] = [];
    const result = await applyLocalChangesToCandidate(
      candidateDb,
      dirtyRows,
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
      (u) => updates.push(u),
    );

    expect(result.uploadedObjects).toBe(1);
    expect(result.dedupedObjects).toBe(1);
    // only one file's worth of content is ever uploaded -- the dedup'd
    // second row contributes 0 bytes, even though both rows count toward
    // filesDone/filesTotal. toMatchObject, not toEqual: see the upload test
    // above for why (the last update also carries an `activity` label).
    expect(updates[updates.length - 1]).toMatchObject({
      filesDone: 2,
      filesTotal: 2,
      bytesDone: 14,
      bytesTotal: 14,
    });

    candidateDb.close();
  });

  it("a deleted row contributes 0 bytes but still advances filesDone/filesTotal", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    new ObjectsRepository(candidateDb).upsert({
      hash: "a".repeat(64),
      s3_key: `objects/${"a".repeat(64)}`,
      size: 5,
      ciphertext_checksum: "crc-test",
    });
    new EntriesRepository(candidateDb).upsert({
      path: "a.txt",
      type: "file",
      hash: "a".repeat(64),
      state_version: "v0",
    });

    const dirtyRow = {
      path: "a.txt",
      type: "file" as const,
      mtime: 1000,
      hash: null,
      size: null,
      state: "deleted" as const,
      parent_state_version: "v0",
    };

    const updates: ProgressUpdate[] = [];
    const result = await applyLocalChangesToCandidate(
      candidateDb,
      [dirtyRow],
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
      (u) => updates.push(u),
    );

    expect(result.appliedCount).toBe(1);
    // Several updates now, not one: rowDiscovered() and rowResolved() each
    // emit their own, even for a delete (fully synchronous, no byte work at
    // all), and settle() emits a last one -- which is what matters, and
    // equals the final tally.
    expect(updates.at(-1)).toEqual({
      filesDone: 1,
      filesTotal: 1,
      bytesDone: 0,
      bytesTotal: 0,
      // settle() runs at the end of every phase, estimate or no estimate:
      // once the pool is idle the totals genuinely are exact.
      totalsFinal: true,
    });
    // The regression test for the discovered/resolved split itself: every
    // row -- even a synchronous one like this delete -- passes through a
    // real intermediate state where it's been counted as discovered but not
    // yet resolved, because rowDiscovered() and rowResolved() are always
    // two separate calls (see progress-types.ts's createProgressTracker).
    expect(updates.some((u) => u.filesTotal > u.filesDone)).toBe(true);

    candidateDb.close();
  });

  it("rewinds the bar when uploadObjectStream reports a retried part, rather than double-counting", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const content = "a".repeat(400);
    touch("a.txt", content);

    // `withS3Retry`'s per-part/per-request retry now lives *inside*
    // `uploadObjectStream` (src/s3/upload-object.ts, covered by its own
    // unit tests) rather than wrapping the whole read-encrypt-write here --
    // this mock stands in for an internal retry by calling `onRetry`
    // itself, which is the one piece of that contract apply-local-changes
    // still owns: wiring the notice to `fileTracker.retrying()` so the bar
    // rewinds and announces the attempt.
    putObjectStreamMock.mockImplementation(
      async (
        _client: unknown,
        _bucket: unknown,
        _key: unknown,
        body: AsyncIterable<unknown>,
        _contentLength: unknown,
        _storageClass: unknown,
        options: UploadObjectStreamOptions = {},
      ) => {
        options.onRetry?.({
          attempt: 1,
          delayMs: 1000,
          elapsedMs: 1000,
          error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        });
        for await (const _chunk of body) {
          // draining is the point
        }
        return "fake-checksum";
      },
    );

    const updates: ProgressUpdate[] = [];
    const result = await applyLocalChangesToCandidate(
      candidateDb,
      [
        {
          path: "a.txt",
          type: "file" as const,
          mtime: 1,
          hash: hashBufferHex(Buffer.from(content)),
          size: content.length,
          state: "created" as const,
          parent_state_version: "v0",
        },
      ],
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
      (u) => updates.push({ ...u }),
    );

    expect(result.uploadedObjects).toBe(1);
    expect(result.conflicts).toEqual([]);

    // The retry announced itself on the bar, naming the attempt so an
    // unlimited retry can't be mistaken for a hang.
    const retryUpdate = updates.find((u) => u.activity?.verb.startsWith("retrying"));
    expect(retryUpdate?.activity?.path).toBe("a.txt");
    expect(retryUpdate?.activity?.verb).toMatch(/^retrying in \d+s \(attempt 1, failing for \d/);
    // ...and it rewound to what was actually committed, which at that point
    // was nothing at all.
    expect(retryUpdate?.bytesDone).toBe(0);

    // No double counting: the file lands on exactly its own size.
    expect(updates.at(-1)).toMatchObject({
      bytesDone: content.length,
      bytesTotal: content.length,
      filesDone: 1,
      filesTotal: 1,
    });

    candidateDb.close();
  });

  it("publishes the enumerated totals before the first row is consumed", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const content = "new upload content";
    touch("a.txt", content);

    const dirtyRow = {
      path: "a.txt",
      type: "file" as const,
      mtime: 1,
      hash: hashBufferHex(Buffer.from(content)),
      size: content.length,
      state: "created" as const,
      parent_state_version: "v0",
    };

    const updates: ProgressUpdate[] = [];
    await applyLocalChangesToCandidate(
      candidateDb,
      [dirtyRow],
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
      (u) => updates.push(u),
      { files: 1, bytes: content.length },
    );

    // The point of the whole exercise: the very first thing the bar is told
    // is the real denominator -- not 0, and not a number that grows as rows
    // are walked.
    expect(updates[0]).toMatchObject({
      filesDone: 0,
      filesTotal: 1,
      bytesDone: 0,
      bytesTotal: content.length,
      totalsFinal: false,
    });
    expect(updates.every((u) => u.bytesTotal === content.length)).toBe(true);

    candidateDb.close();
  });

  it("settles an over-counted estimate back down so the phase lands on 100%", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());

    // A delete transfers nothing, so an estimate that claimed bytes for it
    // (as enumerateUploadWork would for a row it can't tell will conflict)
    // is pure over-count.
    const dirtyRow = {
      path: "gone.txt",
      type: "file" as const,
      mtime: 1000,
      hash: null,
      size: null,
      state: "deleted" as const,
      parent_state_version: "v0",
    };

    const updates: ProgressUpdate[] = [];
    await applyLocalChangesToCandidate(
      candidateDb,
      [dirtyRow],
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
      (u) => updates.push(u),
      { files: 1, bytes: 9999 },
    );

    expect(updates[0]).toMatchObject({ bytesTotal: 9999, totalsFinal: false });
    expect(updates.at(-1)).toEqual({
      filesDone: 1,
      filesTotal: 1,
      bytesDone: 0,
      bytesTotal: 0,
      totalsFinal: true,
    });

    candidateDb.close();
  });
});

describe("applyLocalChangesToCandidate: upload failure", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-apply-local-changes-failure-test-"));
    putObjectStreamMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function touch(relPath: string, content: string, mtime = 1): void {
    const absolute = path.join(root, relPath);
    fs.writeFileSync(absolute, content);
    // The rows below declare `mtime: 1`, and the upload path re-stats the
    // file to confirm it hasn't changed since the scan that hashed it. A
    // fixture whose file and row disagree would be rejected for a reason
    // the test isn't about, so make them agree rather than loosening the
    // check.
    fs.utimesSync(absolute, new Date(mtime), new Date(mtime));
  }

  it("aborts the whole run with S3UploadFatalError, even when an unrelated row's own upload would otherwise have committed cleanly", async () => {
    // A non-transient upload error used to be a per-row failure: this row
    // stayed dirty, everything else in the batch still committed. That
    // changed deliberately -- `uploadObjectStream` (src/s3/upload-
    // object.ts) already retries every *transient* S3 failure internally,
    // forever, so anything it still throws is something no amount of
    // waiting fixes (access denied, a missing bucket, a bug of ours).
    // Leaving the row dirty for "the next sync" to retry would just waste
    // that next sync hitting the same irrecoverable error again -- so the
    // whole run aborts and commits nothing instead, the same escalation
    // `MirrorRequiredError` uses for an exhausted mirror.
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const goodContent = "fine content";
    const badContent = "b".repeat(300); // well past the 100-byte contentLength threshold below
    touch("good.txt", goodContent);
    touch("bad.txt", badContent);
    const badHash = hashBufferHex(Buffer.from(badContent));

    putObjectStreamMock.mockImplementation(
      async (
        _client: unknown,
        _bucket: unknown,
        _key: unknown,
        body: AsyncIterable<unknown>,
        contentLength: unknown,
      ): Promise<string> => {
        for await (const _chunk of body) {
          // draining is the point
        }
        // Distinguished by contentLength, not the S3 key: sync1 is
        // content-addressed, so the key is derived from the hash, never
        // the path/filename -- a mock keyed off "bad" in the key would
        // never actually match either file. contentLength is real,
        // deterministic ciphertext framing (encryptedSize) that differs
        // enough between the two bodies below to tell them apart cleanly.
        if (Number(contentLength) > 100) {
          const err = new Error("Access Denied") as Error & { name: string };
          err.name = "AccessDenied";
          throw err;
        }
        return "fake-checksum";
      },
    );

    const dirtyRows = [
      {
        path: "good.txt",
        type: "file" as const,
        mtime: 1,
        hash: hashBufferHex(Buffer.from(goodContent)),
        size: goodContent.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
      {
        path: "bad.txt",
        type: "file" as const,
        mtime: 1,
        hash: badHash,
        size: badContent.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
    ];

    // A p-queue task rejecting produces an unlistened 'error' event
    // (PQueue extends eventemitter3, which would otherwise print a
    // warning) -- listened here purely to keep the test's own output
    // clean, not because anything needs to react to it.
    const streamPool = new PQueue({ concurrency: 4 });
    streamPool.on("error", () => {});

    const run = applyLocalChangesToCandidate(
      candidateDb,
      dirtyRows,
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      streamPool,
      8,
    );
    // Thrown uncaught, same as `MirrorRequiredError`: this candidate.db is
    // scratch, written to directly as each job completes, and never reaches
    // the real vault -- `performSync` (src/sync/commit.ts) only promotes it
    // past the CAS write once `applyLocalChangesToCandidate` itself
    // resolves, which this run never does. good.txt's row existing *here*
    // reflects that it genuinely finished before bad.txt aborted the batch,
    // not that anything was committed.
    await expect(run).rejects.toBeInstanceOf(S3UploadFatalError);
    await expect(run).rejects.toMatchObject({ paths: ["bad.txt"], hash: badHash });

    candidateDb.close();
  });

  /**
   * The cheap half of the stale-content guard. `encryptStream`'s
   * `expectedHash` catches everything this does and more -- but only after
   * the body is already in flight, which on a multi-GB file means sending
   * the whole thing before rejecting it. A stat costs one syscall and
   * rejects before the first byte, so both exist.
   */
  it("re-stats before uploading, rejecting a file that changed since it was scanned", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const scanned = "content as it was when update_cache hashed it";
    touch("moved-on.txt", scanned);
    // Same content, but the timestamp no longer matches the row -- the
    // cheapest possible signal that a scan's conclusions are stale.
    fs.utimesSync(path.join(root, "moved-on.txt"), new Date(5000), new Date(5000));

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      [
        {
          path: "moved-on.txt",
          type: "file" as const,
          mtime: 1,
          hash: hashBufferHex(Buffer.from(scanned)),
          size: scanned.length,
          state: "created" as const,
          parent_state_version: "v0",
        },
      ],
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
    );

    // Nothing was sent at all -- that is the whole value over the hash
    // check, which would have had to stream the file first.
    expect(putObjectStreamMock).not.toHaveBeenCalled();
    expect(result.uploadedObjects).toBe(0);
    expect(result.handledPaths.has("moved-on.txt")).toBe(false);
    expect(new EntriesRepository(candidateDb).get("moved-on.txt")).toBeUndefined();

    candidateDb.close();
  });

  it("names every path riding on the failed job, not just the one that dispatched it, when S3UploadFatalError aborts the run", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const content = "shared content that will fail to upload";
    const hash = hashBufferHex(Buffer.from(content));
    touch("a.txt", content);
    touch("b.txt", content);

    putObjectStreamMock.mockImplementation(async (): Promise<string> => {
      const err = new Error("Access Denied") as Error & { name: string };
      err.name = "AccessDenied";
      throw err;
    });

    const dirtyRows = [
      {
        path: "a.txt",
        type: "file" as const,
        mtime: 1,
        hash,
        size: content.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
      {
        path: "b.txt",
        type: "file" as const,
        mtime: 1,
        hash,
        size: content.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
    ];

    const streamPool = new PQueue({ concurrency: 4 });
    streamPool.on("error", () => {});

    const run = applyLocalChangesToCandidate(
      candidateDb,
      dirtyRows,
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      streamPool,
      8,
    );

    // b.txt never got a dispatch of its own -- it attached to a.txt's job,
    // the one that actually failed. Both still have to be named in the
    // escalation, not just the dispatcher, or b.txt's own row would go
    // missing from the failure a caller has to report.
    await expect(run).rejects.toBeInstanceOf(S3UploadFatalError);
    await expect(run).rejects.toMatchObject({ paths: ["a.txt", "b.txt"], hash });

    const entriesRepo = new EntriesRepository(candidateDb);
    expect(entriesRepo.get("a.txt")).toBeUndefined();
    expect(entriesRepo.get("b.txt")).toBeUndefined();

    candidateDb.close();
  });

  it("never reports a file's bytes as fully transferred when its upload fails irrecoverably", async () => {
    // `S3UploadFatalError` aborts the whole run uncaught -- same as
    // `MirrorRequiredError` -- so `fileTracker.abort()`/`progress.settle()`
    // are never reached for this file; there is no well-formed "final"
    // update to assert on the way the old leave-dirty-and-continue path
    // had. What still has to hold is the narrower guarantee: nothing ever
    // reports this file's bytes as the completed amount a successful
    // `finish()` would have recorded.
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const content = "a".repeat(500);
    touch("bad.txt", content);

    putObjectStreamMock.mockImplementation(
      async (
        _client: unknown,
        _bucket: unknown,
        _key: unknown,
        body: AsyncIterable<unknown>,
      ): Promise<string> => {
        for await (const _chunk of body) break; // read some of the body, then fail
        const err = new Error("Access Denied") as Error & { name: string };
        err.name = "AccessDenied";
        throw err;
      },
    );

    const updates: ProgressUpdate[] = [];
    const streamPool = new PQueue({ concurrency: 4 });
    streamPool.on("error", () => {});

    await expect(
      applyLocalChangesToCandidate(
        candidateDb,
        [
          {
            path: "bad.txt",
            type: "file" as const,
            mtime: 1,
            hash: hashBufferHex(Buffer.from(content)),
            size: content.length,
            state: "created" as const,
            parent_state_version: "v0",
          },
        ],
        root,
        Buffer.alloc(32),
        "v1",
        unusedS3,
        silentLogger,
        streamPool,
        8,
        (u) => updates.push({ ...u }),
      ),
    ).rejects.toBeInstanceOf(S3UploadFatalError);

    expect(updates.every((u) => u.bytesDone < content.length)).toBe(true);

    candidateDb.close();
  });
});

describe("applyLocalChangesToCandidate: verifyRemote", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-apply-local-changes-verify-remote-test-"));
    putObjectStreamMock.mockReset();
    putObjectStreamMock.mockImplementation(drainBody);
    headObjectMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function touch(relPath: string, content: string, mtime = 1): void {
    const absolute = path.join(root, relPath);
    fs.writeFileSync(absolute, content);
    // The rows below declare `mtime: 1`, and the upload path re-stats the
    // file to confirm it hasn't changed since the scan that hashed it. A
    // fixture whose file and row disagree would be rejected for a reason
    // the test isn't about, so make them agree rather than loosening the
    // check.
    fs.utimesSync(absolute, new Date(mtime), new Date(mtime));
  }

  it("never calls headObject when verifyRemote is left off (the default, ordinary-run shape)", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const content = "new content, not verify-remote";
    touch("a.txt", content);

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      [
        {
          path: "a.txt",
          type: "file" as const,
          mtime: 1,
          hash: hashBufferHex(Buffer.from(content)),
          size: content.length,
          state: "created" as const,
          parent_state_version: "v0",
        },
      ],
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
      undefined,
      undefined,
      // verifyRemote omitted -- defaults to false
    );

    expect(headObjectMock).not.toHaveBeenCalled();
    expect(result.uploadedObjects).toBe(1);
    expect(putObjectStreamMock).toHaveBeenCalledTimes(1);

    candidateDb.close();
  });

  /**
   * The shortcut's price is a checksum. Taking it writes the only
   * `objects` row this hash will ever get -- every later run hits the
   * objectsRepo.has() branch and never re-upserts -- so a checksum absent
   * here would be absent permanently, and 0011 requires one.
   *
   * Declining is deliberately preferred over the two alternatives:
   * failing the run punishes the user for a legacy object, and computing
   * a substitute locally (which convergent encryption makes possible
   * without a download) would record a number nothing corroborated while
   * making it look verified. Re-uploading costs bandwidth once and
   * self-heals permanently.
   */
  it("declines verifyRemote's shortcut and re-uploads when the HEAD reports no checksum", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const content = "present remotely, but from before checksums existed";
    const hash = hashBufferHex(Buffer.from(content));
    touch("legacy.txt", content);
    headObjectMock.mockResolvedValue({ etag: '"deadbeef"' });

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      [
        {
          path: "legacy.txt",
          type: "file" as const,
          mtime: 1,
          hash,
          size: content.length,
          state: "created" as const,
          parent_state_version: "v0",
        },
      ],
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
      undefined,
      undefined,
      true, // verifyRemote
    );

    expect(headObjectMock).toHaveBeenCalledTimes(1);
    // The object was found, yet the upload still ran -- that is the point.
    expect(putObjectStreamMock).toHaveBeenCalledTimes(1);
    expect(result.uploadedObjects).toBe(1);
    expect(result.dedupedObjects).toBe(0);
    expect(result.appliedCount).toBe(1);

    // And the row that resulted carries a real, verified checksum rather
    // than the nothing the HEAD offered.
    const objectsRepo = new ObjectsRepository(candidateDb);
    expect(objectsRepo.get(hash)?.ciphertext_checksum).toBeTruthy();

    candidateDb.close();
  });

  it("skips the upload and records the row when verifyRemote's HEAD check finds the object already on S3", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const content = "already uploaded by a prior aborted run";
    const hash = hashBufferHex(Buffer.from(content));
    touch("recovered.txt", content);
    headObjectMock.mockResolvedValue({
      etag: '"deadbeef"',
      // The shortcut requires one: this HEAD writes the only objects row
      // the hash will ever get, and 0011 made the column NOT NULL.
      checksumCrc64Nvme: "crc-from-head",
    });

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      [
        {
          path: "recovered.txt",
          type: "file" as const,
          mtime: 1,
          hash,
          size: content.length,
          state: "created" as const,
          parent_state_version: "v0",
        },
      ],
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
      undefined,
      undefined,
      true, // verifyRemote
    );

    expect(headObjectMock).toHaveBeenCalledTimes(1);
    // The whole point: no real upload happened, but the row is still fully
    // applied -- exactly as if a dedup hit had resolved it.
    expect(putObjectStreamMock).not.toHaveBeenCalled();
    expect(result.uploadedObjects).toBe(0);
    expect(result.dedupedObjects).toBe(1);
    expect(result.appliedCount).toBe(1);
    expect(result.handledPaths.get("recovered.txt")).toBe("v1");

    const entriesRepo = new EntriesRepository(candidateDb);
    expect(entriesRepo.get("recovered.txt")?.hash).toBe(hash);
    // Unlike the objectsRepo.has(hash) dedup branch, this candidate had no
    // objects row for this hash at all before -- verifyRemote has to write
    // one itself, or a same-batch dedup attach couldn't find it either.
    const objectsRepo = new ObjectsRepository(candidateDb);
    expect(objectsRepo.get(hash)).toMatchObject({
      hash,
      size: content.length,
      // Adopted from the HEAD rather than recomputed: the run that put the
      // object there already had S3 confirm this value, so reading it back
      // is reading a proof, not assuming one.
      ciphertext_checksum: "crc-from-head",
    });

    candidateDb.close();
  });

  it("falls through to a real upload when verifyRemote's HEAD check finds nothing", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const content = "genuinely new content";
    touch("new.txt", content);
    headObjectMock.mockResolvedValue(null);

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      [
        {
          path: "new.txt",
          type: "file" as const,
          mtime: 1,
          hash: hashBufferHex(Buffer.from(content)),
          size: content.length,
          state: "created" as const,
          parent_state_version: "v0",
        },
      ],
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
      undefined,
      undefined,
      true, // verifyRemote
    );

    expect(headObjectMock).toHaveBeenCalledTimes(1);
    expect(putObjectStreamMock).toHaveBeenCalledTimes(1);
    expect(result.uploadedObjects).toBe(1);
    expect(result.dedupedObjects).toBe(0);

    candidateDb.close();
  });

  it("HEAD-checks a hash only once per batch -- a same-batch dedup attach reuses the row the first check already wrote", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const content = "shared, already-recovered content";
    const hash = hashBufferHex(Buffer.from(content));
    touch("a.txt", content);
    touch("b.txt", content);
    headObjectMock.mockResolvedValue({
      etag: '"deadbeef"',
      // The shortcut requires one: this HEAD writes the only objects row
      // the hash will ever get, and 0011 made the column NOT NULL.
      checksumCrc64Nvme: "crc-from-head",
    });

    const dirtyRows = [
      {
        path: "a.txt",
        type: "file" as const,
        mtime: 1,
        hash,
        size: content.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
      {
        path: "b.txt",
        type: "file" as const,
        mtime: 1,
        hash,
        size: content.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
    ];

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      dirtyRows,
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
      undefined,
      undefined,
      true, // verifyRemote
    );

    // b.txt attaches to a.txt's job via inFlightByHash -- claimed
    // synchronously, before a.txt's own HEAD check is even dispatched --
    // rather than independently discovering the object itself. A second
    // HEAD for the same hash in the same batch would just be wasted work.
    // See the dedicated concurrency tests below for the case this guards:
    // attaching while that HEAD is still outstanding, not merely already
    // resolved.
    expect(headObjectMock).toHaveBeenCalledTimes(1);
    expect(putObjectStreamMock).not.toHaveBeenCalled();
    expect(result.dedupedObjects).toBe(2);
    expect(result.handledPaths.get("a.txt")).toBe("v1");
    expect(result.handledPaths.get("b.txt")).toBe("v1");

    candidateDb.close();
  });
});

/** Resolves once something else calls `resolve`/`reject` -- lets a test hold a HEAD check open deliberately. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("applyLocalChangesToCandidate: verifyRemote HEAD checks run concurrently", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-apply-local-changes-head-concurrency-"));
    putObjectStreamMock.mockReset();
    putObjectStreamMock.mockImplementation(drainBody);
    headObjectMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function touch(relPath: string, content: string, mtime = 1): void {
    const absolute = path.join(root, relPath);
    fs.writeFileSync(absolute, content);
    fs.utimesSync(absolute, new Date(mtime), new Date(mtime));
  }

  /**
   * The bug this whole describe block exists to pin: the old code awaited
   * each HEAD inline, one row at a time, so this phase ran at a single
   * connection's pace regardless of --s3-metadata-parallelism. A real sync
   * doing a recovery pass over ~90,000 files at one HEAD at a time, rather
   * than N at a time, is the difference between minutes and hours.
   */
  it("has more than one HEAD check in flight at once, bounded by metadataPool's own concurrency -- not streamPool's", async () => {
    const released: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    headObjectMock.mockImplementation(() => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        released.push(() => {
          inFlight--;
          resolve({ etag: '"etag"' }); // no checksum -- falls through to a real upload
        });
      });
    });

    const dirtyRows = Array.from({ length: 5 }, (_, i) => {
      const content = `distinct content #${i}`;
      touch(`f${i}.txt`, content);
      return {
        path: `f${i}.txt`,
        type: "file" as const,
        mtime: 1,
        hash: hashBufferHex(Buffer.from(content)),
        size: content.length,
        state: "created" as const,
        parent_state_version: "v0",
      };
    });

    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());

    // streamPool deliberately small (1) and distinct from metadataPool (3)
    // -- if the HEAD checks were still sharing streamPool's own budget
    // (or running one at a time regardless of either), maxInFlight could
    // never exceed 1.
    const streamPool = new PQueue({ concurrency: 1 });
    const metadataPool = new PQueue({ concurrency: 3 });

    const resultPromise = applyLocalChangesToCandidate(
      candidateDb,
      dirtyRows,
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      streamPool,
      8,
      undefined,
      undefined,
      true, // verifyRemote
      undefined,
      metadataPool,
      8,
    );

    // Let every HEAD check that *can* start, start, bounded by a real
    // deadline rather than a fixed tick count.
    const deadline = Date.now() + 2000;
    while (released.length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(maxInFlight).toBe(3);

    while (released.length > 0) {
      released.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    const result = await resultPromise;
    expect(result.uploadedObjects).toBe(5);

    candidateDb.close();
  });

  it("attaches a same-batch dedup row while the HEAD check for its hash is still outstanding, and counts both once it resolves found", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const content = "shared content, found on S3 by a slow HEAD";
    const hash = hashBufferHex(Buffer.from(content));
    touch("a.txt", content);
    touch("b.txt", content);

    const head = deferred<{ etag: string; checksumCrc64Nvme?: string }>();
    headObjectMock.mockReturnValue(head.promise);

    const dirtyRows = [
      {
        path: "a.txt",
        type: "file" as const,
        mtime: 1,
        hash,
        size: content.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
      {
        path: "b.txt",
        type: "file" as const,
        mtime: 1,
        hash,
        size: content.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
    ];

    const resultPromise = applyLocalChangesToCandidate(
      candidateDb,
      dirtyRows,
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
      undefined,
      undefined,
      true, // verifyRemote
    );

    // Give both rows a chance to be decided -- a.txt dispatches the HEAD,
    // b.txt (same hash) should find a.txt's job already claimed and attach
    // to it, all before the HEAD below ever resolves.
    await new Promise((r) => setTimeout(r, 20));
    expect(headObjectMock).toHaveBeenCalledTimes(1);

    head.resolve({ etag: '"etag"', checksumCrc64Nvme: "crc-from-head" });
    const result = await resultPromise;

    expect(putObjectStreamMock).not.toHaveBeenCalled();
    expect(result.dedupedObjects).toBe(2);
    expect(result.handledPaths.get("a.txt")).toBe("v1");
    expect(result.handledPaths.get("b.txt")).toBe("v1");
    const objectsRepo = new ObjectsRepository(candidateDb);
    expect(objectsRepo.get(hash)?.ciphertext_checksum).toBe("crc-from-head");

    candidateDb.close();
  });

  it("attaches a same-batch dedup row while the HEAD check is outstanding, and rides along on the upload it escalates to when nothing is found", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const content = "shared content, not found by a slow HEAD";
    const hash = hashBufferHex(Buffer.from(content));
    touch("a.txt", content);
    touch("b.txt", content);

    const head = deferred<null>();
    headObjectMock.mockReturnValue(head.promise);

    const dirtyRows = [
      {
        path: "a.txt",
        type: "file" as const,
        mtime: 1,
        hash,
        size: content.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
      {
        path: "b.txt",
        type: "file" as const,
        mtime: 1,
        hash,
        size: content.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
    ];

    const resultPromise = applyLocalChangesToCandidate(
      candidateDb,
      dirtyRows,
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
      undefined,
      undefined,
      true, // verifyRemote
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(headObjectMock).toHaveBeenCalledTimes(1);

    head.resolve(null); // not on S3 at all -- a real upload is needed
    const result = await resultPromise;

    // One real upload (whichever row dispatched the job), one dedup --
    // b.txt never triggered a HEAD or an upload of its own.
    expect(putObjectStreamMock).toHaveBeenCalledTimes(1);
    expect(result.uploadedObjects).toBe(1);
    expect(result.dedupedObjects).toBe(1);
    expect(result.handledPaths.get("a.txt")).toBe("v1");
    expect(result.handledPaths.get("b.txt")).toBe("v1");

    candidateDb.close();
  });

  /**
   * Parity with the pre-concurrency behavior: the old code awaited the
   * HEAD with no try/catch around it at all, so any failure (a network
   * blip included) propagated straight out of the whole function,
   * uncaught. Dispatching it to a pool must not quietly soften that into
   * a per-row "leave dirty, continue" case.
   */
  it("aborts the whole run, uncaught, when a HEAD check itself fails -- matching the pre-concurrency severity", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const content = "a HEAD that fails outright";
    touch("a.txt", content);
    headObjectMock.mockRejectedValue(new Error("simulated network failure"));

    await expect(
      applyLocalChangesToCandidate(
        candidateDb,
        [
          {
            path: "a.txt",
            type: "file" as const,
            mtime: 1,
            hash: hashBufferHex(Buffer.from(content)),
            size: content.length,
            state: "created" as const,
            parent_state_version: "v0",
          },
        ],
        root,
        Buffer.alloc(32),
        "v1",
        unusedS3,
        silentLogger,
        new PQueue({ concurrency: 4 }),
        8,
        undefined,
        undefined,
        true, // verifyRemote
      ),
    ).rejects.toThrow("simulated network failure");

    candidateDb.close();
  });
});

describe("applyLocalChangesToCandidate: mirror required under --on-mirror-max-retries fail", () => {
  let root: string;
  let mirror: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-apply-local-changes-mirror-fail-test-"));
    mirror = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-apply-local-changes-mirror-drive-"));
    putObjectStreamMock.mockReset();
    putObjectStreamMock.mockImplementation(drainBody);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });

  function touch(relPath: string, content: string, mtime = 1): void {
    const absolute = path.join(root, relPath);
    fs.writeFileSync(absolute, content);
    fs.utimesSync(absolute, new Date(mtime), new Date(mtime));
  }

  /** Sabotages the mirror's shard directory for `hash` so a write to it fails synchronously (mkdirSync). */
  function sabotageMirrorShardFor(hash: string): string {
    const shardParent = path.join(mirror, "objects", hash.slice(0, 2));
    fs.mkdirSync(shardParent, { recursive: true });
    fs.chmodSync(shardParent, 0o555);
    return shardParent;
  }

  it("rejects with MirrorRequiredError, and writes no entry, when the mirror write fails", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const content = "content whose mirror write is sabotaged";
    const hash = hashBufferHex(Buffer.from(content));
    touch("a.txt", content);
    const shardParent = sabotageMirrorShardFor(hash);

    const dirtyRows = [
      {
        path: "a.txt",
        type: "file" as const,
        mtime: 1,
        hash,
        size: content.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
    ];

    const streamPool = new PQueue({ concurrency: 4 });
    streamPool.on("error", () => {});

    const call = applyLocalChangesToCandidate(
      candidateDb,
      dirtyRows,
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      streamPool,
      8,
      undefined,
      undefined,
      false,
      { path: mirror, onMaxRetries: "fail" },
    );

    await expect(call).rejects.toBeInstanceOf(MirrorRequiredError);
    const err = (await call.catch((e: unknown) => e)) as MirrorRequiredError;
    expect(err.paths).toEqual(["a.txt"]);
    expect(err.hash).toBe(hash);
    expect(err.message).toContain("nothing was committed");

    // The S3 side (mocked) "succeeded" independently of the mirror's
    // failure -- exactly the scenario this error class exists to escalate
    // rather than swallow -- but the row must still never have been
    // written to the candidate.
    expect(new EntriesRepository(candidateDb).get("a.txt")).toBeUndefined();

    fs.chmodSync(shardParent, 0o755);
    candidateDb.close();
  });

  it("aborts the whole batch even when an unrelated row's own upload would otherwise have committed cleanly", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const goodContent = "content the mirror can accept just fine";
    const badContent = "content whose mirror write is sabotaged, again";
    touch("good.txt", goodContent);
    touch("bad.txt", badContent);
    const badHash = hashBufferHex(Buffer.from(badContent));
    const shardParent = sabotageMirrorShardFor(badHash);

    const dirtyRows = [
      {
        path: "good.txt",
        type: "file" as const,
        mtime: 1,
        hash: hashBufferHex(Buffer.from(goodContent)),
        size: goodContent.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
      {
        path: "bad.txt",
        type: "file" as const,
        mtime: 1,
        hash: badHash,
        size: badContent.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
    ];

    const streamPool = new PQueue({ concurrency: 4 });
    streamPool.on("error", () => {});

    await expect(
      applyLocalChangesToCandidate(
        candidateDb,
        dirtyRows,
        root,
        Buffer.alloc(32),
        "v1",
        unusedS3,
        silentLogger,
        streamPool,
        8,
        undefined,
        undefined,
        false,
        { path: mirror, onMaxRetries: "fail" },
      ),
    ).rejects.toBeInstanceOf(MirrorRequiredError);

    fs.chmodSync(shardParent, 0o755);
    candidateDb.close();
  });

  it("under --on-mirror-max-retries ignore, commits anyway and counts the gap instead of aborting", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    const content = "content whose mirror write is sabotaged (ignore mode)";
    const hash = hashBufferHex(Buffer.from(content));
    touch("a.txt", content);
    const shardParent = sabotageMirrorShardFor(hash);

    const dirtyRows = [
      {
        path: "a.txt",
        type: "file" as const,
        mtime: 1,
        hash,
        size: content.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
    ];

    const streamPool = new PQueue({ concurrency: 4 });
    streamPool.on("error", () => {});

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      dirtyRows,
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      streamPool,
      8,
      undefined,
      undefined,
      false,
      { path: mirror, onMaxRetries: "ignore" },
    );

    expect(result.appliedCount).toBe(1);
    expect(result.uploadedObjects).toBe(1);
    expect(result.mirrorFailures).toBe(1);
    expect(new EntriesRepository(candidateDb).get("a.txt")?.hash).toBe(hash);

    fs.chmodSync(shardParent, 0o755);
    candidateDb.close();
  });
});

describe("applyLocalChangesToCandidate: uploads directly into the policy's storage class", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-apply-local-changes-storage-class-test-"));
    putObjectStreamMock.mockReset();
    putObjectStreamMock.mockImplementation(drainBody);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function touch(relPath: string, content: string, mtime = 1): void {
    const absolute = path.join(root, relPath);
    fs.writeFileSync(absolute, content);
    fs.utimesSync(absolute, new Date(mtime), new Date(mtime));
  }

  it("passes the matching policy's target class to a new upload, and STANDARD (the default policy) to one that matches nothing else", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    new StoragePoliciesRepository(candidateDb).create("*.mov", "DEEP_ARCHIVE", 0);

    const movContent = "a video that should land straight in cold storage";
    const txtContent = "an ordinary file matching no policy but the default";
    touch("clip.mov", movContent);
    touch("notes.txt", txtContent);

    const dirtyRows = [
      {
        path: "clip.mov",
        type: "file" as const,
        mtime: 1,
        hash: hashBufferHex(Buffer.from(movContent)),
        size: movContent.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
      {
        path: "notes.txt",
        type: "file" as const,
        mtime: 1,
        hash: hashBufferHex(Buffer.from(txtContent)),
        size: txtContent.length,
        state: "created" as const,
        parent_state_version: "v0",
      },
    ];

    const streamPool = new PQueue({ concurrency: 4 });
    streamPool.on("error", () => {});

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      dirtyRows,
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      streamPool,
      8,
    );

    expect(result.appliedCount).toBe(2);
    expect(result.uploadedObjects).toBe(2);
    expect(result.failed).toEqual([]);

    const classByKeySegment = new Map<string, unknown>();
    for (const call of putObjectStreamMock.mock.calls) {
      const key = call[2] as string;
      classByKeySegment.set(key, call[5]);
    }
    // Content-addressed keys, not filenames -- distinguish the two calls by
    // which hash they targeted rather than any name in the S3 key itself.
    const movKey = objectKey(hashBufferHex(Buffer.from(movContent)));
    const txtKey = objectKey(hashBufferHex(Buffer.from(txtContent)));
    expect(classByKeySegment.get(movKey)).toBe("DEEP_ARCHIVE");
    expect(classByKeySegment.get(txtKey)).toBe("STANDARD");

    candidateDb.close();
  });

  it("does not re-upload or reclassify a dedup hit against an object the candidate already knows", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v0", new Date().toISOString());
    new StoragePoliciesRepository(candidateDb).create("*.mov", "DEEP_ARCHIVE", 0);
    const hash = "a".repeat(64);
    new ObjectsRepository(candidateDb).upsert({
      hash,
      s3_key: `objects/${hash}`,
      size: 1,
      ciphertext_checksum: "crc-test",
    });

    const dirtyRow = {
      path: "clip.mov",
      type: "file" as const,
      mtime: 1,
      hash,
      size: 1,
      state: "created" as const,
      parent_state_version: "v0",
    };

    const result = await applyLocalChangesToCandidate(
      candidateDb,
      [dirtyRow],
      root,
      Buffer.alloc(32),
      "v1",
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
    );

    expect(result.dedupedObjects).toBe(1);
    expect(result.uploadedObjects).toBe(0);
    expect(putObjectStreamMock).not.toHaveBeenCalled();

    candidateDb.close();
  });
});
