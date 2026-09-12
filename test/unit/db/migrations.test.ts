import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { runMigrations } from "../../../src/db/migrations/runner.js";

const STATE_MIGRATIONS_DIR = path.resolve("src/db/migrations/state");
const CACHE_MIGRATIONS_DIR = path.resolve("src/db/migrations/cache");

describe("migration runner", () => {
  it("applies state.db migrations and creates the expected tables", () => {
    const db = new Database(":memory:");
    runMigrations(db, STATE_MIGRATIONS_DIR);

    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual([
      "_migrations",
      "entries",
      "ignore_policies",
      "objects",
      "storage_policies",
      "versions",
    ]);
  });

  it("applies cache.db migrations and creates the expected tables", () => {
    const db = new Database(":memory:");
    runMigrations(db, CACHE_MIGRATIONS_DIR);

    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual(["_migrations", "entries"]);
  });

  it("records applied migrations and is idempotent when run again", () => {
    const db = new Database(":memory:");
    runMigrations(db, STATE_MIGRATIONS_DIR);

    const appliedFirst = db
      .prepare<[], { filename: string }>("SELECT filename FROM _migrations ORDER BY filename")
      .all();
    expect(appliedFirst).toEqual([
      { filename: "0001_init.sql" },
      { filename: "0002_add_normalized_path.sql" },
      { filename: "0003_add_ignore_policies.sql" },
      { filename: "0004_add_storage_policies.sql" },
    ]);

    // Running again must not error (e.g. re-executing CREATE TABLE) and must
    // not insert a duplicate _migrations row.
    expect(() => runMigrations(db, STATE_MIGRATIONS_DIR)).not.toThrow();
    const appliedSecond = db
      .prepare<[], { filename: string }>("SELECT filename FROM _migrations")
      .all();
    expect(appliedSecond).toHaveLength(4);
  });

  it("creates the indexes named in the schema", () => {
    const db = new Database(":memory:");
    runMigrations(db, STATE_MIGRATIONS_DIR);
    const indexes = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(indexes).toEqual([
      "idx_entries_hash",
      "idx_entries_normalized_path",
      "idx_entries_state_version",
    ]);
  });
});
