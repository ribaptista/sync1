import Database from "better-sqlite3";
import type { CacheEntryRow } from "./cache-entries-repository.js";
import { toCollisionKey } from "../../fs/case-collision.js";

const SCHEMA = `
CREATE TABLE pending (
  path TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  mtime INTEGER,
  hash TEXT,
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
 * cache.db's connection, so it never conflicts with the open `.iterate()`
 * cursor update_cache holds on cache.db while walking the merge-join.
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
      .prepare<[string, string, number | null, string | null, string, string | null, string]>(
        "INSERT INTO pending (path, type, mtime, hash, state, parent_state_version, normalized_path) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.path,
        row.type,
        row.mtime,
        row.hash,
        row.state,
        row.parent_state_version,
        toCollisionKey(row.path),
      );
  }

  iterateAll(): IterableIterator<CacheEntryRow> {
    return this.db
      .prepare<[], CacheEntryRow>(
        "SELECT path, type, mtime, hash, state, parent_state_version FROM pending",
      )
      .iterate();
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
        "SELECT path, type, mtime, hash, state, parent_state_version FROM pending WHERE normalized_path = ? AND state != 'deleted'",
      )
      .all(normalizedPath);
  }

  close(): void {
    this.db.close();
  }
}
