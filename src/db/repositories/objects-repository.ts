import type Database from "better-sqlite3";
import { paginateKeyset } from "../keyset-pagination.js";

export interface ObjectRow {
  hash: string;
  s3_key: string;
  size: number;
}

interface CountRow {
  c: number;
}

export class ObjectsRepository {
  constructor(private readonly db: Database.Database) {}

  get(hash: string): ObjectRow | undefined {
    return this.db.prepare<[string], ObjectRow>("SELECT * FROM objects WHERE hash = ?").get(hash);
  }

  has(hash: string): boolean {
    return this.get(hash) !== undefined;
  }

  upsert(row: ObjectRow): void {
    this.db
      .prepare<[string, string, number]>(
        "INSERT INTO objects (hash, s3_key, size) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET s3_key = excluded.s3_key, size = excluded.size",
      )
      .run(row.hash, row.s3_key, row.size);
  }

  delete(hash: string): void {
    this.db.prepare<[string]>("DELETE FROM objects WHERE hash = ?").run(hash);
  }

  iterateAll(): IterableIterator<ObjectRow> {
    return this.db.prepare<[], ObjectRow>("SELECT * FROM objects ORDER BY hash ASC").iterate();
  }

  count(): number {
    const row = this.db.prepare<[], CountRow>("SELECT COUNT(*) as c FROM objects").get();
    return row?.c ?? 0;
  }

  /**
   * Count and total byte size of objects no longer referenced by any
   * current entry -- computed entirely in SQL (an anti-join against
   * `entries`, which lives in the same state.db file), so `gc`'s
   * count-only mode never has to hold every object or every referenced
   * hash in memory just to answer "how many/how big".
   */
  countOrphaned(): { count: number; totalSize: number } {
    const row = this.db
      .prepare<[], { c: number; total: number | null }>(
        `SELECT COUNT(*) as c, COALESCE(SUM(size), 0) as total FROM objects
         WHERE hash NOT IN (SELECT DISTINCT hash FROM entries WHERE hash IS NOT NULL)`,
      )
      .get();
    return { count: row?.c ?? 0, totalSize: row?.total ?? 0 };
  }

  /**
   * Stages currently-orphaned objects into a connection-scoped temp table
   * (auto-dropped when the connection closes) so their (hash, s3_key, size)
   * survive `gc`'s bulk local delete -- which must happen before the
   * candidate is uploaded -- through to the S3 deletion afterward, which
   * can only safely happen once the CAS commit has actually succeeded.
   * Avoids ever holding the orphan set as a JS array.
   */
  stageOrphansForDeletion(): void {
    this.db.exec(
      `CREATE TEMP TABLE IF NOT EXISTS gc_pending_deletes (
         hash TEXT PRIMARY KEY, s3_key TEXT NOT NULL, size INTEGER NOT NULL
       );
       DELETE FROM gc_pending_deletes;
       INSERT INTO gc_pending_deletes (hash, s3_key, size)
         SELECT hash, s3_key, size FROM objects
         WHERE hash NOT IN (SELECT DISTINCT hash FROM entries WHERE hash IS NOT NULL);`,
    );
  }

  countStagedOrphans(): { count: number; totalSize: number } {
    const row = this.db
      .prepare<[], { c: number; total: number | null }>(
        "SELECT COUNT(*) as c, COALESCE(SUM(size), 0) as total FROM gc_pending_deletes",
      )
      .get();
    return { count: row?.c ?? 0, totalSize: row?.total ?? 0 };
  }

  /** Removes every staged orphan from `objects` in one statement -- no cursor, no per-row deletes. */
  deleteStagedOrphans(): void {
    this.db.exec("DELETE FROM objects WHERE hash IN (SELECT hash FROM gc_pending_deletes)");
  }

  /**
   * Keyset-paginated (not `.iterate()`) -- `gc --apply`'s delete loop feeds
   * this into a bounded concurrency pool, so nothing may hold this
   * connection's statement open across concurrent work. `hash` is
   * `gc_pending_deletes`' own `PRIMARY KEY`, already indexed. See
   * src/db/keyset-pagination.ts.
   */
  iterateStagedOrphans(): IterableIterator<ObjectRow> {
    return paginateKeyset<ObjectRow, string>(
      (after, limit) =>
        this.db
          .prepare<[string, number], ObjectRow>(
            "SELECT hash, s3_key, size FROM gc_pending_deletes WHERE hash > ? ORDER BY hash ASC LIMIT ?",
          )
          .all(after ?? "", limit),
      (row) => row.hash,
    );
  }
}
