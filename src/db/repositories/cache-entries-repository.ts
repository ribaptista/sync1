import type Database from "better-sqlite3";
import type { EntryType } from "./entries-repository.js";
import { toCollisionKey } from "../../fs/case-collision.js";
import { paginateKeyset } from "../keyset-pagination.js";
import { paginateKeysetFilteredByGlob } from "../glob-scan.js";
import { literalPrefixOf } from "../../fs/glob-match.js";

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
  private readonly getStmt: Database.Statement<[string], CacheEntryRow>;
  private readonly upsertStmt: Database.Statement<
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
  >;
  private readonly deleteStmt: Database.Statement<[string]>;
  private readonly findByNormalizedPathStmt: Database.Statement<[string, string], CacheEntryRow>;
  private readonly countStmt: Database.Statement<[], CountRow>;
  private readonly countDirtyStmt: Database.Statement<[], CountRow>;
  private readonly iterateAllPageStmt: Database.Statement<[string, number], CacheEntryRow>;
  private readonly iterateDirtyDeletedPageStmt: Database.Statement<[string, number], CacheEntryRow>;
  private readonly iterateDirtyRestPageStmt: Database.Statement<[string, number], CacheEntryRow>;
  private readonly globFirstPageStmt: Database.Statement<[string, number], CacheEntryRow>;
  private readonly globNextPageStmt: Database.Statement<[string, number], CacheEntryRow>;

  constructor(private readonly db: Database.Database) {
    // better-sqlite3 does not cache prepared statements on its own -- every
    // `.prepare()` call recompiles the SQL text, which used to happen on
    // every single row (get/upsert/delete are each called once per file in
    // the busiest loops in this codebase). Preparing once per repository
    // instance, here, is the fix.
    this.getStmt = this.db.prepare(`SELECT ${ROW_COLUMNS} FROM entries WHERE path = ?`);
    this.upsertStmt = this.db.prepare(
      "INSERT INTO entries (path, type, mtime, hash, size, state, parent_state_version, normalized_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET type = excluded.type, mtime = excluded.mtime, hash = excluded.hash, size = excluded.size, state = excluded.state, parent_state_version = excluded.parent_state_version, normalized_path = excluded.normalized_path",
    );
    this.deleteStmt = this.db.prepare("DELETE FROM entries WHERE path = ?");
    this.findByNormalizedPathStmt = this.db.prepare(
      `SELECT ${ROW_COLUMNS} FROM entries WHERE normalized_path = ? AND path != ? AND state != 'deleted' LIMIT 1`,
    );
    this.countStmt = this.db.prepare("SELECT COUNT(*) as c FROM entries");
    this.countDirtyStmt = this.db.prepare(
      "SELECT COUNT(*) as c FROM entries WHERE state != 'unchanged'",
    );
    this.iterateAllPageStmt = this.db.prepare(
      `SELECT ${ROW_COLUMNS} FROM entries WHERE path > ? ORDER BY path ASC LIMIT ?`,
    );
    this.iterateDirtyDeletedPageStmt = this.db.prepare(
      `SELECT ${ROW_COLUMNS} FROM entries WHERE state = 'deleted' AND path > ? ORDER BY path ASC LIMIT ?`,
    );
    this.iterateDirtyRestPageStmt = this.db.prepare(
      `SELECT ${ROW_COLUMNS} FROM entries WHERE state != 'unchanged' AND state != 'deleted' AND path > ? ORDER BY path ASC LIMIT ?`,
    );
    this.globFirstPageStmt = this.db.prepare(
      `SELECT ${ROW_COLUMNS} FROM entries WHERE path >= ? ORDER BY path ASC LIMIT ?`,
    );
    this.globNextPageStmt = this.db.prepare(
      `SELECT ${ROW_COLUMNS} FROM entries WHERE path > ? ORDER BY path ASC LIMIT ?`,
    );
  }

  get(path: string): CacheEntryRow | undefined {
    return this.getStmt.get(path);
  }

  upsert(row: CacheEntryRow): void {
    this.upsertStmt.run(
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
    this.deleteStmt.run(path);
  }

  /**
   * Runs `fn` as one transaction against this repository's connection --
   * an escape hatch for callers doing a large, contained sequence of
   * writes (e.g. update_cache's apply loop, batching what would otherwise
   * be one implicit transaction per row). Deliberately not used by
   * `upsert`/`delete` themselves: those stay single-statement so every
   * other call site's existing read-your-own-writes assumptions are
   * unaffected.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Keyset-paginated (not `.iterate()`) -- see src/db/keyset-pagination.ts. `path` is `entries`' own `PRIMARY KEY`, already indexed. */
  iterateAllSortedByPath(): IterableIterator<CacheEntryRow> {
    return paginateKeyset<CacheEntryRow, string>(
      (after, limit) => this.iterateAllPageStmt.all(after ?? "", limit),
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
      (after, limit) => this.iterateDirtyDeletedPageStmt.all(after ?? "", limit),
      (row) => row.path,
    );
    const rest = paginateKeyset<CacheEntryRow, string>(
      (after, limit) => this.iterateDirtyRestPageStmt.all(after ?? "", limit),
      (row) => row.path,
    );
    function* concatenated(): Generator<CacheEntryRow> {
      yield* deleted;
      yield* rest;
    }
    return concatenated();
  }

  /**
   * Matched in memory via `matchesAnyGlob` (see src/fs/glob-match.ts) over
   * a keyset-paginated scan of `entries` -- no SQL `GLOB` filter, since
   * minimatch's dialect doesn't correspond to any SQLite operator. See
   * src/db/glob-scan.ts for how the scan still stays efficient for the
   * common case (a literal filename, or a well-anchored subtree), seeded
   * by `pattern`'s literal prefix rather than a true full scan every time.
   * Used by `materialize`/`stubify`.
   */
  iterateByGlobSortedByPath(pattern: string): IterableIterator<CacheEntryRow> {
    const literalPrefix = literalPrefixOf(pattern);
    return paginateKeysetFilteredByGlob<CacheEntryRow>(
      (after, limit) =>
        after === null
          ? this.globFirstPageStmt.all(literalPrefix, limit)
          : this.globNextPageStmt.all(after, limit),
      (row) => row.path,
      pattern,
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
    return this.findByNormalizedPathStmt.get(normalizedPath, excludePath);
  }

  count(): number {
    const row = this.countStmt.get();
    return row?.c ?? 0;
  }

  countDirty(): number {
    const row = this.countDirtyStmt.get();
    return row?.c ?? 0;
  }
}
