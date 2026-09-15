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
