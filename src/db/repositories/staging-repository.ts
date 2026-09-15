import Database from "better-sqlite3";
import type { CacheEntryRow } from "./cache-entries-repository.js";
import { toCollisionKey } from "../../fs/case-collision.js";
import { paginateKeyset } from "../keyset-pagination.js";

const SCHEMA = `
CREATE TABLE pending (
  path TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  mtime INTEGER,
  hash TEXT,
  size INTEGER CHECK (type != 'file' OR state = 'deleted' OR size IS NOT NULL),
  state TEXT NOT NULL,
  parent_state_version TEXT,
  normalized_path TEXT NOT NULL
);
CREATE INDEX idx_pending_normalized_path ON pending(normalized_path);
`;

/**
 * A throwaway, disk-backed staging area for update_cache's diff, so a scan's
 * changed rows never have to be buffered in an in-memory array (which, on a
 * first-ever scan of a large library, would grow to the size of the whole
 * tree) -- see docs/architecture/cache-and-filesystem-scanning.md. Lives on
 * its own connection/file for the run's duration, entirely separate from
 * cache.db's connection.
 *
 * `normalized_path` is populated now (rather than added later) because it's
 * needed for case-collision detection -- see docs/architecture/
 * cross-platform-filesystem.md.
 */
export class StagingRepository {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.exec(SCHEMA);
  }

  insert(row: CacheEntryRow): void {
    this.db
      .prepare<
        [string, string, number | null, string | null, number | null, string, string | null, string]
      >(
        "INSERT INTO pending (path, type, mtime, hash, size, state, parent_state_version, normalized_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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

  /**
   * Keyset-paginated (not `.iterate()`) by `path` (this table's own
   * `PRIMARY KEY`) so the connection is free between pages -- needed
   * because `detectCaseCollisions` (src/fs/update-cache.ts) runs another
   * query (`isDeletedInBatch`) on this same connection for each yielded
   * row, which a live `.iterate()` cursor would forbid. See
   * src/db/keyset-pagination.ts.
   */
  iterateAll(): IterableIterator<CacheEntryRow> {
    return paginateKeyset<CacheEntryRow, string>(
      (after, limit) =>
        this.db
          .prepare<[string, number], CacheEntryRow>(
            "SELECT path, type, mtime, hash, size, state, parent_state_version FROM pending WHERE path > ? ORDER BY path ASC LIMIT ?",
          )
          .all(after ?? "", limit),
      (row) => row.path,
    );
  }

  /** Whether `path` is staged as a tombstone ('deleted') in this same run's batch. */
  isDeletedInBatch(path: string): boolean {
    const row = this.db
      .prepare<[string], { state: string }>("SELECT state FROM pending WHERE path = ?")
      .get(path);
    return row?.state === "deleted";
  }

  /** Normalized-path groups with more than one currently-live (non-'deleted') row in this same batch. */
  liveCollisionGroups(): string[] {
    const rows = this.db
      .prepare<[], { normalized_path: string }>(
        "SELECT normalized_path FROM pending WHERE state != 'deleted' GROUP BY normalized_path HAVING COUNT(*) > 1",
      )
      .all();
    return rows.map((r) => r.normalized_path);
  }

  /** Every live (non-'deleted') row sharing the given normalized path. */
  liveRowsForNormalizedPath(normalizedPath: string): CacheEntryRow[] {
    return this.db
      .prepare<[string], CacheEntryRow>(
        "SELECT path, type, mtime, hash, size, state, parent_state_version FROM pending WHERE normalized_path = ? AND state != 'deleted'",
      )
      .all(normalizedPath);
  }

  close(): void {
    this.db.close();
  }
}
