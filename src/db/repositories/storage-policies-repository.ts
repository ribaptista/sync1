import type Database from "better-sqlite3";

export type StorageClass = "STANDARD" | "GLACIER" | "DEEP_ARCHIVE";

export interface StoragePolicyRow {
  id: number;
  glob: string | null;
  target_class: StorageClass;
  priority: number | null;
  is_default: 0 | 1;
}

export interface StoragePolicyUpdate {
  glob?: string;
  targetClass?: StorageClass;
  priority?: number;
}

const ROW_COLUMNS = "id, glob, target_class, priority, is_default";

/**
 * state.db's `storage_policies` table -- global, versioned, shared across
 * every machine. Exactly one row always has `is_default = 1` (seeded by
 * the migration itself, never created or deleted through here): its
 * `glob`/`priority` are structurally NULL and permanently outside the
 * priority ordering used to resolve overlapping non-default policies, so
 * only its `target_class` may ever be edited.
 */
export class StoragePoliciesRepository {
  constructor(private readonly db: Database.Database) {}

  list(): StoragePolicyRow[] {
    return this.db
      .prepare<[], StoragePolicyRow>(
        `SELECT ${ROW_COLUMNS} FROM storage_policies ORDER BY is_default ASC, priority ASC, id ASC`,
      )
      .all();
  }

  get(id: number): StoragePolicyRow | undefined {
    return this.db
      .prepare<[number], StoragePolicyRow>(
        `SELECT ${ROW_COLUMNS} FROM storage_policies WHERE id = ?`,
      )
      .get(id);
  }

  getDefault(): StoragePolicyRow {
    const row = this.db
      .prepare<[], StoragePolicyRow>(
        `SELECT ${ROW_COLUMNS} FROM storage_policies WHERE is_default = 1`,
      )
      .get();
    if (!row) throw new Error("storage_policies has no default row -- corrupt state.db?");
    return row;
  }

  /** Every non-default policy, ordered by priority (lower first) -- what policy evaluation (Task SP3) walks. */
  listNonDefaultByPriority(): StoragePolicyRow[] {
    return this.db
      .prepare<[], StoragePolicyRow>(
        `SELECT ${ROW_COLUMNS} FROM storage_policies WHERE is_default = 0 ORDER BY priority ASC, id ASC`,
      )
      .all();
  }

  create(glob: string, targetClass: StorageClass, priority: number): number {
    const result = this.db
      .prepare<[string, StorageClass, number]>(
        "INSERT INTO storage_policies (glob, target_class, priority, is_default) VALUES (?, ?, ?, 0)",
      )
      .run(glob, targetClass, priority);
    return Number(result.lastInsertRowid);
  }

  /**
   * Applies a partial update. Throws if `id` is the default row and the
   * caller tried to touch `glob`/`priority` (only `targetClass` is ever
   * allowed there) -- returns `false`, not an error, for a plain
   * nonexistent id, matching `IgnorePoliciesRepository`'s convention.
   */
  update(id: number, changes: StoragePolicyUpdate): boolean {
    const row = this.get(id);
    if (!row) return false;
    if (row.is_default === 1 && (changes.glob !== undefined || changes.priority !== undefined)) {
      throw new Error(
        "the default policy's glob/priority can't be changed -- only its target_class",
      );
    }

    const glob = changes.glob ?? row.glob;
    const targetClass = changes.targetClass ?? row.target_class;
    const priority = changes.priority ?? row.priority;
    const result = this.db
      .prepare<[string | null, StorageClass, number | null, number]>(
        "UPDATE storage_policies SET glob = ?, target_class = ?, priority = ? WHERE id = ?",
      )
      .run(glob, targetClass, priority, id);
    return result.changes > 0;
  }

  /** Throws if `id` is the default row -- it can never be deleted. Returns `false` for a plain nonexistent id. */
  delete(id: number): boolean {
    const row = this.get(id);
    if (!row) return false;
    if (row.is_default === 1) {
      throw new Error("the default policy can't be deleted");
    }
    const result = this.db.prepare<[number]>("DELETE FROM storage_policies WHERE id = ?").run(id);
    return result.changes > 0;
  }
}
