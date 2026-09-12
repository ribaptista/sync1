import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Logger } from "../../logger.js";

interface MigrationRow {
  filename: string;
}

/**
 * Applies pending numbered .sql migration files from `migrationsDir`, in
 * filename order, each inside its own transaction, tracked in a
 * `_migrations` table. Idempotent — already-applied files are skipped.
 * Migration files are append-only: never edit one after it has shipped,
 * add a new numbered one instead.
 */
export function runMigrations(db: Database.Database, migrationsDir: string, logger?: Logger): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db
      .prepare<[], MigrationRow>("SELECT filename FROM _migrations")
      .all()
      .map((row) => row.filename),
  );

  const pending = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => !applied.has(f));

  for (const filename of pending) {
    const sql = readFileSync(path.join(migrationsDir, filename), "utf8");
    const applyOne = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)").run(
        filename,
        new Date().toISOString(),
      );
    });
    applyOne();
    logger?.debug({ filename, migrationsDir }, "migration applied");
  }
}
