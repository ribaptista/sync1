import type Database from "better-sqlite3";

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
}
