import type Database from "better-sqlite3";

export type EntryType = "file" | "dir";

export interface EntryRow {
  path: string;
  type: EntryType;
  hash: string | null;
  state_version: string;
}

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
    return this.db.prepare<[string], EntryRow>("SELECT * FROM entries WHERE path = ?").get(path);
  }

  upsert(row: EntryRow): void {
    this.db
      .prepare<[string, EntryType, string | null, string]>(
        "INSERT INTO entries (path, type, hash, state_version) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET type = excluded.type, hash = excluded.hash, state_version = excluded.state_version",
      )
      .run(row.path, row.type, row.hash, row.state_version);
  }

  /** Deletions are full row removals, never tombstones (see conflict-resolution design). */
  delete(path: string): void {
    this.db.prepare<[string]>("DELETE FROM entries WHERE path = ?").run(path);
  }

  iterateAllSortedByPath(): IterableIterator<EntryRow> {
    return this.db.prepare<[], EntryRow>("SELECT * FROM entries ORDER BY path ASC").iterate();
  }

  iterateByHash(hash: string): IterableIterator<EntryRow> {
    return this.db
      .prepare<[string], EntryRow>("SELECT * FROM entries WHERE hash = ?")
      .iterate(hash);
  }

  /** Every hash currently referenced by a live entry — the GC "keep" set. */
  iterateDistinctReferencedHashes(): IterableIterator<HashRow> {
    return this.db
      .prepare<[], HashRow>("SELECT DISTINCT hash FROM entries WHERE hash IS NOT NULL")
      .iterate();
  }

  count(): number {
    const row = this.db.prepare<[], CountRow>("SELECT COUNT(*) as c FROM entries").get();
    return row?.c ?? 0;
  }
}
