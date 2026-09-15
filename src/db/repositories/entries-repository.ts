import type Database from "better-sqlite3";
import { toCollisionKey } from "../../fs/case-collision.js";
import { paginateKeyset } from "../keyset-pagination.js";
import { paginateKeysetFilteredByGlob } from "../glob-scan.js";
import { literalPrefixOf } from "../../fs/glob-match.js";

export type EntryType = "file" | "dir";

export interface EntryRow {
  path: string;
  type: EntryType;
  hash: string | null;
  state_version: string;
}

const ROW_COLUMNS = "path, type, hash, state_version";

interface CountRow {
  c: number;
}

interface HashRow {
  hash: string;
}

/** state.db's `entries` table — the versioned, committed source of truth. */
export class EntriesRepository {
  constructor(private readonly db: Database.Database) {}

  get(path: string): EntryRow | undefined {
    return this.db
      .prepare<[string], EntryRow>(`SELECT ${ROW_COLUMNS} FROM entries WHERE path = ?`)
      .get(path);
  }

  upsert(row: EntryRow): void {
    this.db
      .prepare<[string, EntryType, string | null, string, string]>(
        "INSERT INTO entries (path, type, hash, state_version, normalized_path) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET type = excluded.type, hash = excluded.hash, state_version = excluded.state_version, normalized_path = excluded.normalized_path",
      )
      .run(row.path, row.type, row.hash, row.state_version, toCollisionKey(row.path));
  }

  /** Deletions are full row removals, never tombstones (see conflict-resolution design). */
  delete(path: string): void {
    this.db.prepare<[string]>("DELETE FROM entries WHERE path = ?").run(path);
  }

  /**
   * Keyset-paginated (not `.iterate()`): a live cursor would hold this
   * connection's statement open between `.next()` calls, forbidding any
   * other statement on it -- exactly the constraint AGENTS.md's pagination
   * rule exists to avoid. `path` is `entries`' own `PRIMARY KEY`, already
   * indexed. See src/db/keyset-pagination.ts.
   */
  iterateAllSortedByPath(): IterableIterator<EntryRow> {
    return paginateKeyset<EntryRow, string>(
      (after, limit) =>
        this.db
          .prepare<[string, number], EntryRow>(
            `SELECT ${ROW_COLUMNS} FROM entries WHERE path > ? ORDER BY path ASC LIMIT ?`,
          )
          .all(after ?? "", limit),
      (row) => row.path,
    );
  }

  iterateByHash(hash: string): IterableIterator<EntryRow> {
    return this.db
      .prepare<[string], EntryRow>(`SELECT ${ROW_COLUMNS} FROM entries WHERE hash = ?`)
      .iterate(hash);
  }

  /**
   * Matched in memory via `matchesAnyGlob` (see src/fs/glob-match.ts) over
   * a keyset-paginated scan of `entries` -- no SQL `GLOB` filter, since
   * minimatch's dialect doesn't correspond to any SQLite operator. See
   * src/db/glob-scan.ts for how the scan still stays efficient for the
   * common case (a literal filename, or a well-anchored subtree), seeded
   * by `pattern`'s literal prefix rather than a true full scan every time.
   * Used by `inspect`.
   */
  iterateByGlobSortedByPath(pattern: string): IterableIterator<EntryRow> {
    const literalPrefix = literalPrefixOf(pattern);
    return paginateKeysetFilteredByGlob<EntryRow>(
      (after, limit) =>
        after === null
          ? this.db
              .prepare<[string, number], EntryRow>(
                `SELECT ${ROW_COLUMNS} FROM entries WHERE path >= ? ORDER BY path ASC LIMIT ?`,
              )
              .all(literalPrefix, limit)
          : this.db
              .prepare<[string, number], EntryRow>(
                `SELECT ${ROW_COLUMNS} FROM entries WHERE path > ? ORDER BY path ASC LIMIT ?`,
              )
              .all(after, limit),
      (row) => row.path,
      pattern,
    );
  }

  /**
   * Distinct hashes among paths matching `pattern` (directories excluded,
   * since they have no hash/storage class). One row per *content*, not per
   * path, since operations like `status`/`converge` act on the underlying
   * object, which may be referenced by several paths.
   *
   * Scans `entries` ordered by `path` (reusing its own primary-key index,
   * not `idx_entries_hash`) rather than by `hash` -- SQL can no longer
   * pre-filter by path before deduping by hash, since there's no SQL GLOB
   * filter at all (see src/db/glob-scan.ts). Dedup happens in an in-memory
   * `Set`, yielding a hash only the first time it's seen -- the same
   * "small enough to hold in memory" reasoning already relied on for the
   * nested `iterateByHash` read this feeds (stays synchronous throughout,
   * see converge-storage-policies.ts), just applied to the distinct-hash
   * count instead of one hash's path list.
   */
  iterateDistinctHashesMatchingGlob(pattern: string): IterableIterator<HashRow> {
    const literalPrefix = literalPrefixOf(pattern);
    const scan = paginateKeysetFilteredByGlob<EntryRow>(
      (after, limit) =>
        after === null
          ? this.db
              .prepare<[string, number], EntryRow>(
                `SELECT ${ROW_COLUMNS} FROM entries WHERE hash IS NOT NULL AND path >= ? ORDER BY path ASC LIMIT ?`,
              )
              .all(literalPrefix, limit)
          : this.db
              .prepare<[string, number], EntryRow>(
                `SELECT ${ROW_COLUMNS} FROM entries WHERE hash IS NOT NULL AND path > ? ORDER BY path ASC LIMIT ?`,
              )
              .all(after, limit),
      (row) => row.path,
      pattern,
    );

    function* dedup(): Generator<HashRow> {
      const seen = new Set<string>();
      for (const row of scan) {
        if (row.hash === null || seen.has(row.hash)) continue;
        seen.add(row.hash);
        yield { hash: row.hash };
      }
    }
    return dedup();
  }

  /**
   * Finds a row with the given normalized (lowercased) path, other than
   * `excludePath` itself -- used for case-insensitive collision detection
   * against the candidate state.db being folded into a commit. Uses the
   * `normalized_path` index rather than `path = ? COLLATE NOCASE`, which
   * couldn't use `path`'s own (BINARY-collation) index and would force a
   * full scan. Unlike cache.db's version, no tombstone state to exclude:
   * a deleted entry here is a removed row, not a lingering one. See
   * docs/architecture/cross-platform-filesystem.md.
   */
  findByNormalizedPath(normalizedPath: string, excludePath: string): EntryRow | undefined {
    return this.db
      .prepare<[string, string], EntryRow>(
        `SELECT ${ROW_COLUMNS} FROM entries WHERE normalized_path = ? AND path != ? LIMIT 1`,
      )
      .get(normalizedPath, excludePath);
  }

  count(): number {
    const row = this.db.prepare<[], CountRow>("SELECT COUNT(*) as c FROM entries").get();
    return row?.c ?? 0;
  }
}
