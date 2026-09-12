import type Database from "better-sqlite3";
import type { EntryType } from "./entries-repository.js";

export type CacheState = "created" | "modified" | "deleted" | "unchanged";

export interface CacheEntryRow {
  path: string;
  type: EntryType;
  mtime: number | null;
  hash: string | null;
  state: CacheState;
  parent_state_version: string | null;
}

interface CountRow {
  c: number;
}

/** cache.db's `entries` table — local-only, unencrypted, regenerable from the filesystem. */
export class CacheEntriesRepository {
  constructor(private readonly db: Database.Database) {}

  get(path: string): CacheEntryRow | undefined {
    return this.db
      .prepare<[string], CacheEntryRow>("SELECT * FROM entries WHERE path = ?")
      .get(path);
  }

  upsert(row: CacheEntryRow): void {
    this.db
      .prepare<[string, EntryType, number | null, string | null, CacheState, string | null]>(
        "INSERT INTO entries (path, type, mtime, hash, state, parent_state_version) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET type = excluded.type, mtime = excluded.mtime, hash = excluded.hash, state = excluded.state, parent_state_version = excluded.parent_state_version",
      )
      .run(row.path, row.type, row.mtime, row.hash, row.state, row.parent_state_version);
  }

  delete(path: string): void {
    this.db.prepare<[string]>("DELETE FROM entries WHERE path = ?").run(path);
  }

  iterateAllSortedByPath(): IterableIterator<CacheEntryRow> {
    return this.db.prepare<[], CacheEntryRow>("SELECT * FROM entries ORDER BY path ASC").iterate();
  }

  /** Uses the partial idx_cache_state index — rows with pending local changes. */
  iterateDirty(): IterableIterator<CacheEntryRow> {
    return this.db
      .prepare<[], CacheEntryRow>(
        "SELECT * FROM entries WHERE state != 'unchanged' ORDER BY path ASC",
      )
      .iterate();
  }

  /** SQLite's native GLOB operator against `path` -- used by materialize/stubify. */
  iterateByGlobSortedByPath(pattern: string): IterableIterator<CacheEntryRow> {
    return this.db
      .prepare<[string], CacheEntryRow>("SELECT * FROM entries WHERE path GLOB ? ORDER BY path ASC")
      .iterate(pattern);
  }

  count(): number {
    const row = this.db.prepare<[], CountRow>("SELECT COUNT(*) as c FROM entries").get();
    return row?.c ?? 0;
  }
}
