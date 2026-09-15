import { describe, it, expect } from "vitest";
import { openStateDb, openCacheDb } from "../../../src/db/connection.js";
import { VersionsRepository } from "../../../src/db/repositories/versions-repository.js";
import { ObjectsRepository } from "../../../src/db/repositories/objects-repository.js";
import { EntriesRepository } from "../../../src/db/repositories/entries-repository.js";
import {
  CacheEntriesRepository,
  type CacheEntryRow,
} from "../../../src/db/repositories/cache-entries-repository.js";
import { IgnorePoliciesRepository } from "../../../src/db/repositories/ignore-policies-repository.js";
import { StoragePoliciesRepository } from "../../../src/db/repositories/storage-policies-repository.js";
import { ThumbnailPoliciesRepository } from "../../../src/db/repositories/thumbnail-policies-repository.js";

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

  it("computes orphan count/size via an anti-join against entries, entirely in SQL", () => {
    const db = openStateDb(":memory:");
    new VersionsRepository(db).insert("v0", "2026-01-01T00:00:00.000Z");
    const objectsRepo = new ObjectsRepository(db);
    const entriesRepo = new EntriesRepository(db);

    objectsRepo.upsert({ hash: "referenced", s3_key: "objects/referenced", size: 10 });
    objectsRepo.upsert({ hash: "orphan1", s3_key: "objects/orphan1", size: 20 });
    objectsRepo.upsert({ hash: "orphan2", s3_key: "objects/orphan2", size: 30 });
    entriesRepo.upsert({ path: "a.txt", type: "file", hash: "referenced", state_version: "v0" });

    const { count, totalSize } = objectsRepo.countOrphaned();
    expect(count).toBe(2);
    expect(totalSize).toBe(50);
  });

  it("stages orphans, deletes them locally, then reports them for S3 cleanup", () => {
    const db = openStateDb(":memory:");
    new VersionsRepository(db).insert("v0", "2026-01-01T00:00:00.000Z");
    const objectsRepo = new ObjectsRepository(db);
    const entriesRepo = new EntriesRepository(db);

    objectsRepo.upsert({ hash: "referenced", s3_key: "objects/referenced", size: 10 });
    objectsRepo.upsert({ hash: "orphan1", s3_key: "objects/orphan1", size: 20 });
    entriesRepo.upsert({ path: "a.txt", type: "file", hash: "referenced", state_version: "v0" });

    objectsRepo.stageOrphansForDeletion();
    expect(objectsRepo.countStagedOrphans()).toEqual({ count: 1, totalSize: 20 });

    objectsRepo.deleteStagedOrphans();
    expect(objectsRepo.has("orphan1")).toBe(false);
    expect(objectsRepo.has("referenced")).toBe(true); // untouched

    // the staged list itself survives the deletion (it's a separate temp
    // table), which is exactly what lets gc drive S3 cleanup afterward
    const staged = [...objectsRepo.iterateStagedOrphans()];
    expect(staged).toEqual([{ hash: "orphan1", s3_key: "objects/orphan1", size: 20 }]);
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

  describe("iterateByGlobSortedByPath", () => {
    it("matches a '**' pattern across nested directories", () => {
      const db = openStateDb(":memory:");
      new VersionsRepository(db).insert("v0", "2026-01-01T00:00:00.000Z");
      const repo = new EntriesRepository(db);
      repo.upsert({ path: "photos/a.jpg", type: "file", hash: null, state_version: "v0" });
      repo.upsert({ path: "photos/sub/b.jpg", type: "file", hash: null, state_version: "v0" });
      repo.upsert({ path: "docs/c.txt", type: "file", hash: null, state_version: "v0" });

      const paths = [...repo.iterateByGlobSortedByPath("photos/**/*.jpg")].map((r) => r.path);
      expect(paths).toEqual(["photos/a.jpg", "photos/sub/b.jpg"]);
    });

    it("matches dotfiles like any other name", () => {
      const db = openStateDb(":memory:");
      new VersionsRepository(db).insert("v0", "2026-01-01T00:00:00.000Z");
      const repo = new EntriesRepository(db);
      repo.upsert({ path: ".env", type: "file", hash: null, state_version: "v0" });
      repo.upsert({ path: "readme.md", type: "file", hash: null, state_version: "v0" });

      const paths = [...repo.iterateByGlobSortedByPath("*")].map((r) => r.path);
      expect(paths).toEqual([".env", "readme.md"]);
    });

    it("still finds every match for a leading-wildcard pattern (no literal prefix to seed from)", () => {
      const db = openStateDb(":memory:");
      new VersionsRepository(db).insert("v0", "2026-01-01T00:00:00.000Z");
      const repo = new EntriesRepository(db);
      repo.upsert({ path: "a.jpg", type: "file", hash: null, state_version: "v0" });
      repo.upsert({ path: "sub/b.jpg", type: "file", hash: null, state_version: "v0" });
      repo.upsert({ path: "z.jpg", type: "file", hash: null, state_version: "v0" });

      const paths = [...repo.iterateByGlobSortedByPath("*.jpg")].map((r) => r.path);
      expect(paths).toEqual(["a.jpg", "z.jpg"]); // segment-bound '*' excludes "sub/b.jpg"
    });

    it("a literal-prefix-anchored pattern excludes a sibling sharing only a raw string prefix", () => {
      const db = openStateDb(":memory:");
      new VersionsRepository(db).insert("v0", "2026-01-01T00:00:00.000Z");
      const repo = new EntriesRepository(db);
      repo.upsert({ path: "Photos/2024/a.jpg", type: "file", hash: null, state_version: "v0" });
      // Shares the raw string prefix "Photos/2024" but is not actually
      // under that directory -- the seed/stop range in glob-scan.ts is
      // deliberately loose (a byte-prefix bound, not a path-segment bound),
      // so this row gets visited; matchesAnyGlob must still reject it.
      repo.upsert({ path: "Photos/20245.txt", type: "file", hash: null, state_version: "v0" });

      const paths = [...repo.iterateByGlobSortedByPath("Photos/2024/*.jpg")].map((r) => r.path);
      expect(paths).toEqual(["Photos/2024/a.jpg"]);
    });
  });

  describe("iterateDistinctHashesMatchingGlob", () => {
    it("yields a hash exactly once even when only some of its several paths match the glob", () => {
      const db = openStateDb(":memory:");
      new VersionsRepository(db).insert("v0", "2026-01-01T00:00:00.000Z");
      new ObjectsRepository(db).upsert({ hash: "h1", s3_key: "objects/h1", size: 1 });
      new ObjectsRepository(db).upsert({ hash: "h2", s3_key: "objects/h2", size: 1 });
      const repo = new EntriesRepository(db);
      // Same content, dedup'd, referenced by both a matching and a
      // non-matching path.
      repo.upsert({ path: "photos/a.jpg", type: "file", hash: "h1", state_version: "v0" });
      repo.upsert({ path: "archive/a.jpg", type: "file", hash: "h1", state_version: "v0" });
      repo.upsert({ path: "photos/b.jpg", type: "file", hash: "h2", state_version: "v0" });

      const hashes = [...repo.iterateDistinctHashesMatchingGlob("photos/*")]
        .map((r) => r.hash)
        .sort();
      expect(hashes).toEqual(["h1", "h2"]);
    });
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
      size: 100,
      state: "created",
      parent_state_version: "v0",
    });
    expect(repo.get("photos/a.jpg")?.state).toBe("created");
  });

  it("size round-trips through upsert/get, and a conflicting upsert updates it", () => {
    const db = openCacheDb(":memory:");
    const repo = new CacheEntriesRepository(db);
    repo.upsert({
      path: "a.txt",
      type: "file",
      mtime: 1,
      hash: "h1",
      size: 123,
      state: "unchanged",
      parent_state_version: "v0",
    });
    expect(repo.get("a.txt")?.size).toBe(123);

    repo.upsert({
      path: "a.txt",
      type: "file",
      mtime: 2,
      hash: "h2",
      size: 456,
      state: "modified",
      parent_state_version: "v0",
    });
    expect(repo.get("a.txt")?.size).toBe(456);
  });

  it("accepts a null size for a directory row and for a deleted (tombstone) row", () => {
    const db = openCacheDb(":memory:");
    const repo = new CacheEntriesRepository(db);
    repo.upsert({
      path: "dir",
      type: "dir",
      mtime: 1,
      hash: null,
      size: null,
      state: "unchanged",
      parent_state_version: "v0",
    });
    expect(repo.get("dir")?.size).toBeNull();

    repo.upsert({
      path: "gone.txt",
      type: "file",
      mtime: null,
      hash: null,
      size: null,
      state: "deleted",
      parent_state_version: "v0",
    });
    expect(repo.get("gone.txt")?.size).toBeNull();
  });

  it("rejects a null size for a live (non-deleted) file row at the database level", () => {
    const db = openCacheDb(":memory:");
    const repo = new CacheEntriesRepository(db);
    expect(() =>
      repo.upsert({
        path: "bad.txt",
        type: "file",
        mtime: 1,
        hash: "h1",
        size: null,
        state: "unchanged",
        parent_state_version: "v0",
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it("iterateDirty only returns non-unchanged rows", () => {
    const db = openCacheDb(":memory:");
    const repo = new CacheEntriesRepository(db);
    repo.upsert({
      path: "a.txt",
      type: "file",
      mtime: 1,
      hash: "h1",
      size: 10,
      state: "unchanged",
      parent_state_version: "v0",
    });
    repo.upsert({
      path: "b.txt",
      type: "file",
      mtime: 2,
      hash: "h2",
      size: 20,
      state: "modified",
      parent_state_version: "v0",
    });
    repo.upsert({
      path: "c.txt",
      type: "file",
      mtime: null,
      hash: null,
      size: null,
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
      size: 10,
      state: "created",
      parent_state_version: "v0",
    });
    repo.upsert({
      path: "aaa.txt",
      type: "file",
      mtime: null,
      hash: null,
      size: null,
      state: "deleted",
      parent_state_version: "v0",
    });
    repo.upsert({
      path: "file.txt",
      type: "file",
      mtime: null,
      hash: null,
      size: null,
      state: "deleted",
      parent_state_version: "v0",
    });
    repo.upsert({
      path: "zzz.txt",
      type: "file",
      mtime: 2,
      hash: "h2",
      size: 20,
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
        size: 10,
        state: "unchanged",
        parent_state_version: "v0",
      });
    }
    const paths = [...repo.iterateAllSortedByPath()].map((r) => r.path);
    expect(paths).toEqual(["a.txt", "m/nested.txt", "z.txt"]);
  });

  it("findByNormalizedPath finds a live row differing only by case, via the indexed column", () => {
    const db = openCacheDb(":memory:");
    const repo = new CacheEntriesRepository(db);
    repo.upsert({
      path: "file.txt",
      type: "file",
      mtime: 1,
      hash: "h1",
      size: 10,
      state: "unchanged",
      parent_state_version: "v0",
    });

    const hit = repo.findByNormalizedPath("file.txt", "FILE.txt");
    expect(hit?.path).toBe("file.txt");

    // never matches itself
    expect(repo.findByNormalizedPath("file.txt", "file.txt")).toBeUndefined();
    // no collision at all
    expect(repo.findByNormalizedPath("nope.txt", "other.txt")).toBeUndefined();
  });

  it("findByNormalizedPath ignores a tombstoned ('deleted') row", () => {
    const db = openCacheDb(":memory:");
    const repo = new CacheEntriesRepository(db);
    repo.upsert({
      path: "file.txt",
      type: "file",
      mtime: null,
      hash: null,
      size: null,
      state: "deleted",
      parent_state_version: "v0",
    });

    // a tombstone must never block a legitimately different case-variant
    // path from being accepted (e.g. a rename's create half)
    expect(repo.findByNormalizedPath("file.txt", "FILE.txt")).toBeUndefined();
  });

  describe("iterateByGlobSortedByPath", () => {
    function row(path: string): CacheEntryRow {
      return {
        path,
        type: "file",
        mtime: 1,
        hash: "h1",
        size: 1,
        state: "unchanged",
        parent_state_version: "v0",
      };
    }

    it("matches a '**' pattern across nested directories", () => {
      const db = openCacheDb(":memory:");
      const repo = new CacheEntriesRepository(db);
      repo.upsert(row("photos/a.jpg"));
      repo.upsert(row("photos/sub/b.jpg"));
      repo.upsert(row("docs/c.txt"));

      const paths = [...repo.iterateByGlobSortedByPath("photos/**/*.jpg")].map((r) => r.path);
      expect(paths).toEqual(["photos/a.jpg", "photos/sub/b.jpg"]);
    });

    it("matches dotfiles like any other name", () => {
      const db = openCacheDb(":memory:");
      const repo = new CacheEntriesRepository(db);
      repo.upsert(row(".env"));
      repo.upsert(row("readme.md"));

      const paths = [...repo.iterateByGlobSortedByPath("*")].map((r) => r.path);
      expect(paths).toEqual([".env", "readme.md"]);
    });

    it("still finds every match for a leading-wildcard pattern (no literal prefix to seed from)", () => {
      const db = openCacheDb(":memory:");
      const repo = new CacheEntriesRepository(db);
      repo.upsert(row("a.jpg"));
      repo.upsert(row("sub/b.jpg"));
      repo.upsert(row("z.jpg"));

      const paths = [...repo.iterateByGlobSortedByPath("*.jpg")].map((r) => r.path);
      expect(paths).toEqual(["a.jpg", "z.jpg"]); // segment-bound '*' excludes "sub/b.jpg"
    });

    it("a literal-prefix-anchored pattern excludes a sibling sharing only a raw string prefix", () => {
      const db = openCacheDb(":memory:");
      const repo = new CacheEntriesRepository(db);
      repo.upsert(row("Photos/2024/a.jpg"));
      // Shares the raw string prefix "Photos/2024" but is not actually
      // under that directory -- the seed/stop range in glob-scan.ts is
      // deliberately loose (a byte-prefix bound, not a path-segment
      // bound), so this row gets visited; matchesAnyGlob must still
      // reject it.
      repo.upsert(row("Photos/20245.txt"));

      const paths = [...repo.iterateByGlobSortedByPath("Photos/2024/*.jpg")].map((r) => r.path);
      expect(paths).toEqual(["Photos/2024/a.jpg"]);
    });
  });
});

describe("IgnorePoliciesRepository (state.db)", () => {
  it("creates, lists, updates, and deletes policies", () => {
    const db = openStateDb(":memory:");
    const repo = new IgnorePoliciesRepository(db);

    const id = repo.create("*.tmp");
    expect(repo.list()).toEqual([{ id, glob: "*.tmp", created_at: expect.any(String) as string }]);
    expect(repo.get(id)?.glob).toBe("*.tmp");

    expect(repo.update(id, "*.bak")).toBe(true);
    expect(repo.get(id)?.glob).toBe("*.bak");
    expect(repo.update(999, "*.nope")).toBe(false);

    expect(repo.delete(id)).toBe(true);
    expect(repo.get(id)).toBeUndefined();
    expect(repo.delete(id)).toBe(false);
  });

  it("listGlobs returns every glob as a plain string array", () => {
    const db = openStateDb(":memory:");
    const repo = new IgnorePoliciesRepository(db);
    repo.create("*.tmp");
    repo.create("photos/raw/*");

    expect(repo.listGlobs().sort()).toEqual(["*.tmp", "photos/raw/*"]);
  });
});

describe("StoragePoliciesRepository (state.db)", () => {
  it("seeds exactly one default row from the migration itself", () => {
    const db = openStateDb(":memory:");
    const repo = new StoragePoliciesRepository(db);

    const all = repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({
      id: expect.any(Number) as number,
      glob: null,
      target_class: "STANDARD",
      priority: null,
      is_default: 1,
    });
    expect(repo.getDefault()).toEqual(all[0]);
    expect(repo.listNonDefaultByPriority()).toEqual([]);
  });

  it("creates, lists (default last), updates, and deletes non-default policies", () => {
    const db = openStateDb(":memory:");
    const repo = new StoragePoliciesRepository(db);

    const coldId = repo.create("archive/*", "DEEP_ARCHIVE", 1);
    const warmId = repo.create("archive/keep-warm/*", "STANDARD", 0);

    const all = repo.list();
    expect(all.map((r) => r.id)).toEqual([warmId, coldId, expect.any(Number) as number]); // priority order, default last
    expect(repo.listNonDefaultByPriority().map((r) => r.id)).toEqual([warmId, coldId]);

    expect(repo.get(coldId)).toEqual({
      id: coldId,
      glob: "archive/*",
      target_class: "DEEP_ARCHIVE",
      priority: 1,
      is_default: 0,
    });

    expect(repo.update(coldId, { targetClass: "GLACIER", priority: 2 })).toBe(true);
    expect(repo.get(coldId)).toMatchObject({ target_class: "GLACIER", priority: 2 });
    expect(repo.update(999, { targetClass: "STANDARD" })).toBe(false);

    expect(repo.delete(warmId)).toBe(true);
    expect(repo.get(warmId)).toBeUndefined();
    expect(repo.delete(warmId)).toBe(false);
  });

  it("only allows the default row's target_class to change, never its glob/priority", () => {
    const db = openStateDb(":memory:");
    const repo = new StoragePoliciesRepository(db);
    const defaultId = repo.getDefault().id;

    expect(repo.update(defaultId, { targetClass: "GLACIER" })).toBe(true);
    expect(repo.getDefault().target_class).toBe("GLACIER");

    expect(() => repo.update(defaultId, { glob: "*" })).toThrow(/glob\/priority/);
    expect(() => repo.update(defaultId, { priority: 5 })).toThrow(/glob\/priority/);
  });

  it("refuses to delete the default row", () => {
    const db = openStateDb(":memory:");
    const repo = new StoragePoliciesRepository(db);
    const defaultId = repo.getDefault().id;

    expect(() => repo.delete(defaultId)).toThrow(/default policy can't be deleted/);
    expect(repo.get(defaultId)).toBeDefined();
  });
});

const GENERATE_INPUT = {
  glob: "**/*.jpg",
  action: "generate" as const,
  mimeTypes: ["image/jpeg"],
  priority: 0,
  imageWidth: 320,
  imageHeight: 240,
  tileRowCount: 4,
  tileColumnCount: 4,
  tileWidth: 160,
  tileHeight: 90,
  jpegQuality: 80,
};

const SKIP_INPUT = {
  glob: "private/**",
  action: "skip" as const,
  mimeTypes: ["image/*", "video/*"],
};

describe("ThumbnailPoliciesRepository (state.db)", () => {
  it("starts empty -- no mandatory default row, unlike storage_policies", () => {
    const db = openStateDb(":memory:");
    const repo = new ThumbnailPoliciesRepository(db);
    expect(repo.list()).toEqual([]);
  });

  it("creates, lists, gets, updates, and deletes both skip and generate rows", () => {
    const db = openStateDb(":memory:");
    const repo = new ThumbnailPoliciesRepository(db);

    const generateId = repo.create(GENERATE_INPUT);
    const skipId = repo.create(SKIP_INPUT);

    expect(repo.list().map((r) => r.id)).toEqual([generateId, skipId]);

    expect(repo.get(generateId)).toEqual({
      id: generateId,
      glob: "**/*.jpg",
      action: "generate",
      priority: 0,
      mimeTypes: ["image/jpeg"],
      imageWidth: 320,
      imageHeight: 240,
      tileRowCount: 4,
      tileColumnCount: 4,
      tileWidth: 160,
      tileHeight: 90,
      jpegQuality: 80,
      createdAt: expect.any(String) as string,
    });

    expect(repo.get(skipId)).toEqual({
      id: skipId,
      glob: "private/**",
      action: "skip",
      priority: null,
      mimeTypes: ["image/*", "video/*"],
      imageWidth: null,
      imageHeight: null,
      tileRowCount: null,
      tileColumnCount: null,
      tileWidth: null,
      tileHeight: null,
      jpegQuality: null,
      createdAt: expect.any(String) as string,
    });

    expect(repo.update(generateId, { jpegQuality: 60, priority: 5 })).toBe(true);
    expect(repo.get(generateId)).toMatchObject({ jpegQuality: 60, priority: 5 });
    expect(repo.update(999, { jpegQuality: 60 })).toBe(false);

    expect(repo.delete(skipId)).toBe(true);
    expect(repo.get(skipId)).toBeUndefined();
    expect(repo.delete(skipId)).toBe(false);
  });

  it("round-trips mimeTypes through the JSON-encoded column, preserving order", () => {
    const db = openStateDb(":memory:");
    const repo = new ThumbnailPoliciesRepository(db);
    const id = repo.create({ ...SKIP_INPUT, mimeTypes: ["video/*", "image/png", "image/jpeg"] });
    expect(repo.get(id)?.mimeTypes).toEqual(["video/*", "image/png", "image/jpeg"]);
  });

  it("listGenerateByPriority orders by priority, listSkip returns only skip rows", () => {
    const db = openStateDb(":memory:");
    const repo = new ThumbnailPoliciesRepository(db);
    const lowId = repo.create({ ...GENERATE_INPUT, glob: "a/*", priority: 5 });
    const highId = repo.create({ ...GENERATE_INPUT, glob: "b/*", priority: 1 });
    const skipId = repo.create(SKIP_INPUT);

    expect(repo.listGenerateByPriority().map((r) => r.id)).toEqual([highId, lowId]);
    expect(repo.listSkip().map((r) => r.id)).toEqual([skipId]);
  });

  it("rejects a 'skip' policy that sets a priority or any generate field", () => {
    const db = openStateDb(":memory:");
    const repo = new ThumbnailPoliciesRepository(db);
    expect(() => repo.create({ ...SKIP_INPUT, priority: 1 })).toThrow(/priority/);
    expect(() => repo.create({ ...SKIP_INPUT, jpegQuality: 80 })).toThrow(/jpegQuality/);
  });

  it("rejects a 'generate' policy missing a priority or any generate field", () => {
    const db = openStateDb(":memory:");
    const repo = new ThumbnailPoliciesRepository(db);
    const { priority: _priority, ...withoutPriority } = GENERATE_INPUT;
    expect(() => repo.create(withoutPriority)).toThrow(/priority/);

    const { jpegQuality: _jpegQuality, ...withoutQuality } = GENERATE_INPUT;
    expect(() => repo.create(withoutQuality)).toThrow(/jpegQuality/);
  });

  it("rejects an invalid mime type, and requires at least one", () => {
    const db = openStateDb(":memory:");
    const repo = new ThumbnailPoliciesRepository(db);
    expect(() => repo.create({ ...SKIP_INPUT, mimeTypes: ["not-a-mime-type"] })).toThrow(
      /invalid mime type/,
    );
    expect(() => repo.create({ ...SKIP_INPUT, mimeTypes: [] })).toThrow(/at least one mime type/);
    expect(repo.create({ ...SKIP_INPUT, mimeTypes: ["video/*"] })).toEqual(expect.any(Number));
  });

  it("update() re-validates the merged whole, catching an update that would leave it inconsistent", () => {
    const db = openStateDb(":memory:");
    const repo = new ThumbnailPoliciesRepository(db);
    const generateId = repo.create(GENERATE_INPUT);

    // Clearing jpegQuality alone (without also switching to 'skip') would
    // leave a 'generate' row missing a required field.
    expect(() => repo.update(generateId, { mimeTypes: [] })).toThrow(/at least one mime type/);
  });

  it("update() switching action clears the fields that no longer apply", () => {
    const db = openStateDb(":memory:");
    const repo = new ThumbnailPoliciesRepository(db);
    const generateId = repo.create(GENERATE_INPUT);

    expect(repo.update(generateId, { action: "skip" })).toBe(true);
    expect(repo.get(generateId)).toMatchObject({
      action: "skip",
      priority: null,
      imageWidth: null,
      imageHeight: null,
      tileRowCount: null,
      tileColumnCount: null,
      tileWidth: null,
      tileHeight: null,
      jpegQuality: null,
    });

    const skipId = repo.create(SKIP_INPUT);
    // Switching skip -> generate without supplying the newly-required fields
    // in the same call fails -- nothing carries over from the skip row's
    // (all-null) generate fields.
    expect(() => repo.update(skipId, { action: "generate", priority: 0 })).toThrow(/imageWidth/);
    expect(
      repo.update(skipId, {
        action: "generate",
        priority: 0,
        imageWidth: 100,
        imageHeight: 100,
        tileRowCount: 2,
        tileColumnCount: 2,
        tileWidth: 50,
        tileHeight: 50,
        jpegQuality: 70,
      }),
    ).toBe(true);
    expect(repo.get(skipId)).toMatchObject({ action: "generate", priority: 0, imageWidth: 100 });
  });
});
