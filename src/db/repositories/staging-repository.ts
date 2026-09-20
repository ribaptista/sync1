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
 * How many buffered rows accumulate before `insert()` commits them as one
 * transaction -- see the constructor's own comment on why this table is
 * batched at all. 500 is not tuned to anything specific; it's small enough
 * that a crash mid-scan loses at most a few hundred already-classified
 * rows' worth of redone work, large enough that a first-ever 54k-entry
 * scan commits roughly 100 times instead of 54,529.
 */
const INSERT_BATCH_SIZE = 500;

/**
 * A throwaway, disk-backed staging area for update_cache's diff, so a scan's
 * changed rows never have to be buffered in an in-memory array (which, on a
 * first-ever scan of a large library, would grow to the size of the whole
 * tree) -- see docs/architecture/cache-and-filesystem-scanning.md. Lives on
 * its own connection/file for the run's duration, entirely separate from
 * cache.db's connection.
 *
 * `synchronous = OFF`: every row here is redone from scratch by the next
 * run's own merge-join if this file is lost to a crash (it's deleted in a
 * `finally` regardless, successful run or not), so there is nothing to
 * protect against a power loss losing the last few fsyncs -- unlike
 * cache.db or state.db, this table's durability is worth exactly zero.
 * Paired with the batching below: on a spinning disk, an implicit
 * transaction per `INSERT` was measured as the actual bottleneck of a
 * first-ever scan (see performUpdateCache's own doc comment), not read
 * throughput.
 */
export class StagingRepository {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly runInsertBatch: Database.Transaction<(rows: CacheEntryRow[]) => void>;
  // Buffered here, not written immediately -- insert() below batches these
  // into one transaction every INSERT_BATCH_SIZE rows (or whenever a read
  // method needs to see them). Never observably different from writing
  // immediately: every read method flushes this first, so nothing this
  // repository's own callers can do ever sees a stale answer.
  private pendingInserts: CacheEntryRow[] = [];

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = OFF");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("cache_size = -64000"); // 64 MiB; negative means KiB, per SQLite's own convention
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.insertStmt = this.db.prepare(
      "INSERT INTO pending (path, type, mtime, hash, size, state, parent_state_version, normalized_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.runInsertBatch = this.db.transaction((rows: CacheEntryRow[]) => {
      for (const row of rows) {
        this.insertStmt.run(
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
    });
  }

  insert(row: CacheEntryRow): void {
    this.pendingInserts.push(row);
    if (this.pendingInserts.length >= INSERT_BATCH_SIZE) this.flush();
  }

  /**
   * Commits every buffered row as one transaction. Idempotent (a no-op
   * once the buffer is empty) and safe to call as often as needed -- every
   * read method below calls this first, so a caller never has to think
   * about when to flush; it exists as its own method mainly so `close()`
   * has something cheap to call unconditionally.
   */
  flush(): void {
    if (this.pendingInserts.length === 0) return;
    const rows = this.pendingInserts;
    this.pendingInserts = [];
    this.runInsertBatch(rows);
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
    this.flush();
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
    this.flush();
    const row = this.db
      .prepare<[string], { state: string }>("SELECT state FROM pending WHERE path = ?")
      .get(path);
    return row?.state === "deleted";
  }

  /** Normalized-path groups with more than one currently-live (non-'deleted') row in this same batch. */
  liveCollisionGroups(): string[] {
    this.flush();
    const rows = this.db
      .prepare<[], { normalized_path: string }>(
        "SELECT normalized_path FROM pending WHERE state != 'deleted' GROUP BY normalized_path HAVING COUNT(*) > 1",
      )
      .all();
    return rows.map((r) => r.normalized_path);
  }

  /** Every live (non-'deleted') row sharing the given normalized path. */
  liveRowsForNormalizedPath(normalizedPath: string): CacheEntryRow[] {
    this.flush();
    return this.db
      .prepare<[string], CacheEntryRow>(
        "SELECT path, type, mtime, hash, size, state, parent_state_version FROM pending WHERE normalized_path = ? AND state != 'deleted'",
      )
      .all(normalizedPath);
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}
