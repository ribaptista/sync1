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
import type { ProgressUpdate } from "../../../src/progress-types.js";

vi.mock("../../../src/s3/client.js", () => ({
  // Drains the body stream, same as a real S3 client would -- otherwise the
  // encrypt pipeline never finishes flowing, and the source file read can
  // race past this test's own cleanup.
  putObjectStream: vi.fn(
    async (_client: unknown, _bucket: unknown, _key: unknown, body: AsyncIterable<unknown>) => {
      for await (const _chunk of body) {
        // draining is the point
      }
    },
  ),
}));

const { applyLocalChangesToCandidate } = await import("../../../src/sync/apply-local-changes.js");
const { putObjectStream } = await import("../../../src/s3/client.js");
const putObjectStreamMock = vi.mocked(putObjectStream);

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
    new ObjectsRepository(candidateDb).upsert({ hash: HASH, s3_key: `objects/${HASH}`, size: 1 });
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
    putObjectStreamMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function touch(relPath: string, content: string): void {
    fs.writeFileSync(path.join(root, relPath), content);
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
    putObjectStreamMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function touch(relPath: string, content: string): void {
    fs.writeFileSync(path.join(root, relPath), content);
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
    // Two updates now, not one: rowDiscovered() and rowResolved() each emit
    // their own update, even for a delete (fully synchronous, no byte work
    // at all) -- the last one is what matters, and equals the final tally.
    expect(updates.at(-1)).toEqual({
      filesDone: 1,
      filesTotal: 1,
      bytesDone: 0,
      bytesTotal: 0,
      // Provisional: this phase never enumerated ahead of itself, so
      // nothing ever declared its totals exact.
      totalsFinal: false,
    });
    // The regression test for the discovered/resolved split itself: every
    // row -- even a synchronous one like this delete -- passes through a
    // real intermediate state where it's been counted as discovered but not
    // yet resolved, because rowDiscovered() and rowResolved() are always
    // two separate calls (see progress-types.ts's createProgressTracker).
    expect(updates.some((u) => u.filesTotal > u.filesDone)).toBe(true);

    candidateDb.close();
  });
});
