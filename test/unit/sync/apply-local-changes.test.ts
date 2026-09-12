import { describe, it, expect } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { openStateDb } from "../../../src/db/connection.js";
import { EntriesRepository } from "../../../src/db/repositories/entries-repository.js";
import { ObjectsRepository } from "../../../src/db/repositories/objects-repository.js";
import { VersionsRepository } from "../../../src/db/repositories/versions-repository.js";
import { applyLocalChangesToCandidate } from "../../../src/sync/apply-local-changes.js";

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
    );

    expect(result.conflicts).toEqual([]);
    expect(result.handledPaths.has("photo.jpg")).toBe(true);

    candidateDb.close();
  });
});
