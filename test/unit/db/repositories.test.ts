import { describe, it, expect } from "vitest";
import { openStateDb, openCacheDb } from "../../../src/db/connection.js";
import { VersionsRepository } from "../../../src/db/repositories/versions-repository.js";
import { ObjectsRepository } from "../../../src/db/repositories/objects-repository.js";
import { EntriesRepository } from "../../../src/db/repositories/entries-repository.js";
import { CacheEntriesRepository } from "../../../src/db/repositories/cache-entries-repository.js";

describe("VersionsRepository", () => {
  it("inserts and reads back versions in sequence order", () => {
    const db = openStateDb(":memory:");
    const repo = new VersionsRepository(db);

    repo.insert("v0", "2026-01-01T00:00:00.000Z");
    repo.insert("v1", "2026-01-02T00:00:00.000Z");

    const latest = repo.getLatest();
    expect(latest?.version_stamp).toBe("v1");
    expect(latest?.sequence).toBe(2);

    const v0 = repo.getByVersionStamp("v0");
    expect(v0?.sequence).toBe(1);

    const all = [...repo.iterateAll()].map((r) => r.version_stamp);
    expect(all).toEqual(["v0", "v1"]);
  });
});

describe("ObjectsRepository", () => {
  it("upserts, reads, and deletes object rows", () => {
    const db = openStateDb(":memory:");
    const repo = new ObjectsRepository(db);

    repo.upsert({ hash: "aaa", s3_key: "objects/aaa", size: 100 });
    expect(repo.has("aaa")).toBe(true);
    expect(repo.get("aaa")).toEqual({ hash: "aaa", s3_key: "objects/aaa", size: 100 });

    // upsert on conflict updates fields
    repo.upsert({ hash: "aaa", s3_key: "objects/aaa-moved", size: 200 });
    expect(repo.get("aaa")).toEqual({ hash: "aaa", s3_key: "objects/aaa-moved", size: 200 });

    repo.upsert({ hash: "bbb", s3_key: "objects/bbb", size: 50 });
    expect(repo.count()).toBe(2);

    repo.delete("aaa");
    expect(repo.has("aaa")).toBe(false);
    expect(repo.count()).toBe(1);
  });

  it("iterates all rows in hash order", () => {
    const db = openStateDb(":memory:");
    const repo = new ObjectsRepository(db);
    repo.upsert({ hash: "ccc", s3_key: "objects/ccc", size: 1 });
    repo.upsert({ hash: "aaa", s3_key: "objects/aaa", size: 1 });
    repo.upsert({ hash: "bbb", s3_key: "objects/bbb", size: 1 });

    const hashes = [...repo.iterateAll()].map((r) => r.hash);
    expect(hashes).toEqual(["aaa", "bbb", "ccc"]);
  });
});

describe("EntriesRepository (state.db)", () => {
  it("upserts entries referencing a committed version and object", () => {
    const db = openStateDb(":memory:");
    new VersionsRepository(db).insert("v0", "2026-01-01T00:00:00.000Z");
    new ObjectsRepository(db).upsert({ hash: "h1", s3_key: "objects/h1", size: 10 });
    const repo = new EntriesRepository(db);

    repo.upsert({ path: "photos/a.jpg", type: "file", hash: "h1", state_version: "v0" });
    expect(repo.get("photos/a.jpg")).toEqual({
      path: "photos/a.jpg",
      type: "file",
      hash: "h1",
      state_version: "v0",
    });
  });

  it("deletions are full row removals, not tombstones", () => {
    const db = openStateDb(":memory:");
    new VersionsRepository(db).insert("v0", "2026-01-01T00:00:00.000Z");
    const repo = new EntriesRepository(db);
    repo.upsert({ path: "a.txt", type: "file", hash: null, state_version: "v0" });
    repo.delete("a.txt");
    expect(repo.get("a.txt")).toBeUndefined();
  });

  it("iterateAllSortedByPath returns rows in lexicographic path order", () => {
    const db = openStateDb(":memory:");
    new VersionsRepository(db).insert("v0", "2026-01-01T00:00:00.000Z");
    const repo = new EntriesRepository(db);
    repo.upsert({ path: "z.txt", type: "file", hash: null, state_version: "v0" });
    repo.upsert({ path: "a.txt", type: "file", hash: null, state_version: "v0" });
    repo.upsert({ path: "m/nested.txt", type: "file", hash: null, state_version: "v0" });

    const paths = [...repo.iterateAllSortedByPath()].map((r) => r.path);
    expect(paths).toEqual(["a.txt", "m/nested.txt", "z.txt"]);
  });

  it("iterateDistinctReferencedHashes supports GC's referenced-hash set", () => {
    const db = openStateDb(":memory:");
    new VersionsRepository(db).insert("v0", "2026-01-01T00:00:00.000Z");
    const objects = new ObjectsRepository(db);
    objects.upsert({ hash: "h1", s3_key: "objects/h1", size: 1 });
    objects.upsert({ hash: "h2", s3_key: "objects/h2", size: 1 });
    const repo = new EntriesRepository(db);
    repo.upsert({ path: "a.txt", type: "file", hash: "h1", state_version: "v0" });
    repo.upsert({ path: "b.txt", type: "file", hash: "h1", state_version: "v0" }); // dedup: shares h1
    repo.upsert({ path: "c.txt", type: "file", hash: "h2", state_version: "v0" });
    repo.upsert({ path: "dir", type: "dir", hash: null, state_version: "v0" });

    const hashes = [...repo.iterateDistinctReferencedHashes()].map((r) => r.hash).sort();
    expect(hashes).toEqual(["h1", "h2"]);
  });
});

describe("CacheEntriesRepository (cache.db)", () => {
  it("upserts and reads local-only cache rows", () => {
    const db = openCacheDb(":memory:");
    const repo = new CacheEntriesRepository(db);
    repo.upsert({
      path: "photos/a.jpg",
      type: "file",
      mtime: 12345,
      hash: "h1",
      state: "created",
      parent_state_version: "v0",
    });
    expect(repo.get("photos/a.jpg")?.state).toBe("created");
  });

  it("iterateDirty only returns non-unchanged rows", () => {
    const db = openCacheDb(":memory:");
    const repo = new CacheEntriesRepository(db);
    repo.upsert({
      path: "a.txt",
      type: "file",
      mtime: 1,
      hash: "h1",
      state: "unchanged",
      parent_state_version: "v0",
    });
    repo.upsert({
      path: "b.txt",
      type: "file",
      mtime: 2,
      hash: "h2",
      state: "modified",
      parent_state_version: "v0",
    });
    repo.upsert({
      path: "c.txt",
      type: "file",
      mtime: null,
      hash: null,
      state: "deleted",
      parent_state_version: "v0",
    });

    const dirtyPaths = [...repo.iterateDirty()].map((r) => r.path);
    // deleted rows first (c.txt), then created/modified by path (b.txt) --
    // see iterateDirty()'s doc comment for why this ordering matters.
    expect(dirtyPaths).toEqual(["c.txt", "b.txt"]);
  });

  it("iterateDirty always orders every deleted row before every created/modified row, regardless of path", () => {
    const db = openCacheDb(":memory:");
    const repo = new CacheEntriesRepository(db);
    // Deliberately alphabetically interleaved, so a plain path-only sort
    // would NOT put all deletions first -- e.g. "FILE.txt" (created) sorts
    // before "file.txt" (deleted) in plain ASCII order.
    repo.upsert({
      path: "FILE.txt",
      type: "file",
      mtime: 1,
      hash: "h1",
      state: "created",
      parent_state_version: "v0",
    });
    repo.upsert({
      path: "aaa.txt",
      type: "file",
      mtime: null,
      hash: null,
      state: "deleted",
      parent_state_version: "v0",
    });
    repo.upsert({
      path: "file.txt",
      type: "file",
      mtime: null,
      hash: null,
      state: "deleted",
      parent_state_version: "v0",
    });
    repo.upsert({
      path: "zzz.txt",
      type: "file",
      mtime: 2,
      hash: "h2",
      state: "modified",
      parent_state_version: "v0",
    });

    const dirtyRows = [...repo.iterateDirty()];
    const deletedIndex = dirtyRows.findIndex((r) => r.state !== "deleted");
    expect(dirtyRows.slice(0, deletedIndex).every((r) => r.state === "deleted")).toBe(true);
    expect(dirtyRows.slice(deletedIndex).every((r) => r.state !== "deleted")).toBe(true);
    expect(dirtyRows.map((r) => r.path)).toEqual(["aaa.txt", "file.txt", "FILE.txt", "zzz.txt"]);
  });

  it("iterateAllSortedByPath returns rows in lexicographic path order", () => {
    const db = openCacheDb(":memory:");
    const repo = new CacheEntriesRepository(db);
    for (const p of ["z.txt", "a.txt", "m/nested.txt"]) {
      repo.upsert({
        path: p,
        type: "file",
        mtime: 1,
        hash: "h",
        state: "unchanged",
        parent_state_version: "v0",
      });
    }
    const paths = [...repo.iterateAllSortedByPath()].map((r) => r.path);
    expect(paths).toEqual(["a.txt", "m/nested.txt", "z.txt"]);
  });
});
