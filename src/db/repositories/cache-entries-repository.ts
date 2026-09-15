import type Database from "better-sqlite3";
import type { EntryType } from "./entries-repository.js";
import { toCollisionKey } from "../../fs/case-collision.js";
import { paginateKeyset } from "../keyset-pagination.js";

export type CacheState = "created" | "modified" | "deleted" | "unchanged";

export interface CacheEntryRow {
  path: string;
  type: EntryType;
  mtime: number | null;
  hash: string | null;
  /** Bytes. NULL only for a directory row or a tombstone ('deleted') -- DB-enforced, see 0004_add_size.sql. */
  size: number | null;
  state: CacheState;
  parent_state_version: string | null;
}

const ROW_COLUMNS = "path, type, mtime, hash, size, state, parent_state_version";

interface CountRow {
  c: number;
}

/** cache.db's `entries` table — local-only, unencrypted, regenerable from the filesystem. */
export class CacheEntriesRepository {
  constructor(private readonly db: Database.Database) {}

  get(path: string): CacheEntryRow | undefined {
    return this.db
      .prepare<[string], CacheEntryRow>(`SELECT ${ROW_COLUMNS} FROM entries WHERE path = ?`)
      .get(path);
  }

  upsert(row: CacheEntryRow): void {
    this.db
      .prepare<
        [
          string,
          EntryType,
          number | null,
          string | null,
          number | null,
          CacheState,
          string | null,
          string,
        ]
      >(
        "INSERT INTO entries (path, type, mtime, hash, size, state, parent_state_version, normalized_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET type = excluded.type, mtime = excluded.mtime, hash = excluded.hash, size = excluded.size, state = excluded.state, parent_state_version = excluded.parent_state_version, normalized_path = excluded.normalized_path",
      )
      .run(
        row.path,
        row.type,
        row.mtime,
        row.hash,
        row.size,
        row.state,
        row.parent_state_version,
        toCollisionKey(row.path),
      );
  }

  delete(path: string): void {
    this.db.prepare<[string]>("DELETE FROM entries WHERE path = ?").run(path);
  }

  /** Keyset-paginated (not `.iterate()`) -- see src/db/keyset-pagination.ts. `path` is `entries`' own `PRIMARY KEY`, already indexed. */
  iterateAllSortedByPath(): IterableIterator<CacheEntryRow> {
    return paginateKeyset<CacheEntryRow, string>(
      (after, limit) =>
        this.db
          .prepare<[string, number], CacheEntryRow>(
            `SELECT ${ROW_COLUMNS} FROM entries WHERE path > ? ORDER BY path ASC LIMIT ?`,
          )
          .all(after ?? "", limit),
      (row) => row.path,
    );
  }

  /**
   * Every 'deleted' row before any 'created'/'modified' row (then by path
   * within each group) — this matters for a same-machine rename
   * (update_cache always resolves it as an independent delete+create,
   * since there's no rename primitive anywhere in this system): folding
   * the delete half into the candidate before the create half is checked
   * means a case-insensitive collision check never sees the old path as
   * still "live" merely because it hasn't been processed yet. Without
   * this, whether a rename happened to trigger a false collision would
   * depend on which way the casing changed sorted alphabetically — see
   * docs/architecture/cross-platform-filesystem.md.
   *
   * Implemented as two concatenated single-column keyset-paginated
   * queries (deleted-by-path, then the rest-by-path) rather than a
   * row-value keyset comparison on the compound sort key — simpler, and
   * preserves the exact same "deleted group entirely before the rest"
   * guarantee. Both use the composite idx_cache_state_path index (state,
   * path), which covers this filter+ordering exactly.
   */
  iterateDirty(): IterableIterator<CacheEntryRow> {
    const deleted = paginateKeyset<CacheEntryRow, string>(
      (after, limit) =>
        this.db
          .prepare<[string, number], CacheEntryRow>(
            `SELECT ${ROW_COLUMNS} FROM entries WHERE state = 'deleted' AND path > ? ORDER BY path ASC LIMIT ?`,
          )
          .all(after ?? "", limit),
      (row) => row.path,
    );
    const rest = paginateKeyset<CacheEntryRow, string>(
      (after, limit) =>
        this.db
          .prepare<[string, number], CacheEntryRow>(
            `SELECT ${ROW_COLUMNS} FROM entries WHERE state != 'unchanged' AND state != 'deleted' AND path > ? ORDER BY path ASC LIMIT ?`,
          )
          .all(after ?? "", limit),
      (row) => row.path,
    );
    function* concatenated(): Generator<CacheEntryRow> {
      yield* deleted;
      yield* rest;
    }
    return concatenated();
  }

  /** SQLite's native GLOB operator against `path` -- used by materialize/stubify. Keyset-paginated, same reasoning as iterateAllSortedByPath. */
  iterateByGlobSortedByPath(pattern: string): IterableIterator<CacheEntryRow> {
    return paginateKeyset<CacheEntryRow, string>(
      (after, limit) =>
        this.db
          .prepare<[string, string, number], CacheEntryRow>(
            `SELECT ${ROW_COLUMNS} FROM entries WHERE path GLOB ? AND path > ? ORDER BY path ASC LIMIT ?`,
          )
          .all(pattern, after ?? "", limit),
      (row) => row.path,
    );
  }

  /**
   * Finds a currently-*live* row (never a tombstone) with the given
   * normalized (lowercased) path, other than `excludePath` itself -- used
   * for case-insensitive collision detection. Uses the `normalized_path`
   * index rather than `path = ? COLLATE NOCASE`, which couldn't use
   * `path`'s own (BINARY-collation) index and would force a full scan. A
   * tombstoned ('deleted') row is deliberately excluded: it must never
   * block a legitimately different path from being accepted (e.g. a
   * remote rename, modeled as delete-`file.txt`+create-`FILE.txt`, must
   * not have its `FILE.txt` half rejected just because `file.txt`'s
   * tombstone is still sitting in cache.db). See
   * docs/architecture/cross-platform-filesystem.md.
   */
  findByNormalizedPath(normalizedPath: string, excludePath: string): CacheEntryRow | undefined {
    return this.db
      .prepare<[string, string], CacheEntryRow>(
        `SELECT ${ROW_COLUMNS} FROM entries WHERE normalized_path = ? AND path != ? AND state != 'deleted' LIMIT 1`,
      )
      .get(normalizedPath, excludePath);
  }

  count(): number {
    const row = this.db.prepare<[], CountRow>("SELECT COUNT(*) as c FROM entries").get();
    return row?.c ?? 0;
  }

  countDirty(): number {
    const row = this.db
      .prepare<[], CountRow>("SELECT COUNT(*) as c FROM entries WHERE state != 'unchanged'")
      .get();
    return row?.c ?? 0;
  }
}
