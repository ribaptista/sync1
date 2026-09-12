import type Database from "better-sqlite3";

export interface VersionRow {
  sequence: number;
  version_stamp: string;
  created_at: string;
}

export class VersionsRepository {
  constructor(private readonly db: Database.Database) {}

  insert(versionStamp: string, createdAt: string): number {
    const result = this.db
      .prepare<[string, string]>("INSERT INTO versions (version_stamp, created_at) VALUES (?, ?)")
      .run(versionStamp, createdAt);
    return Number(result.lastInsertRowid);
  }

  getByVersionStamp(versionStamp: string): VersionRow | undefined {
    return this.db
      .prepare<[string], VersionRow>("SELECT * FROM versions WHERE version_stamp = ?")
      .get(versionStamp);
  }

  getLatest(): VersionRow | undefined {
    return this.db
      .prepare<[], VersionRow>("SELECT * FROM versions ORDER BY sequence DESC LIMIT 1")
      .get();
  }

  iterateAll(): IterableIterator<VersionRow> {
    return this.db
      .prepare<[], VersionRow>("SELECT * FROM versions ORDER BY sequence ASC")
      .iterate();
  }
}
