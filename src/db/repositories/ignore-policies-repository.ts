import type Database from "better-sqlite3";

export interface IgnorePolicyRow {
  id: number;
  glob: string;
  created_at: string;
}

/** state.db's `ignore_policies` table — global, versioned, shared across every machine. */
export class IgnorePoliciesRepository {
  constructor(private readonly db: Database.Database) {}

  list(): IgnorePolicyRow[] {
    return this.db
      .prepare<[], IgnorePolicyRow>(
        "SELECT id, glob, created_at FROM ignore_policies ORDER BY id ASC",
      )
      .all();
  }

  get(id: number): IgnorePolicyRow | undefined {
    return this.db
      .prepare<[number], IgnorePolicyRow>(
        "SELECT id, glob, created_at FROM ignore_policies WHERE id = ?",
      )
      .get(id);
  }

  create(glob: string): number {
    const result = this.db
      .prepare<[string, string]>("INSERT INTO ignore_policies (glob, created_at) VALUES (?, ?)")
      .run(glob, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  update(id: number, glob: string): boolean {
    const result = this.db
      .prepare<[string, number]>("UPDATE ignore_policies SET glob = ? WHERE id = ?")
      .run(glob, id);
    return result.changes > 0;
  }

  delete(id: number): boolean {
    const result = this.db.prepare<[number]>("DELETE FROM ignore_policies WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** Every glob, for preloading before a merge-join that can't query mid-iteration. */
  listGlobs(): string[] {
    return this.db
      .prepare<[], { glob: string }>("SELECT glob FROM ignore_policies")
      .all()
      .map((r) => r.glob);
  }
}
