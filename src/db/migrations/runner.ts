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
 *
 * **Foreign keys are disabled for the duration of the pass, and every
 * migration ends with a `foreign_key_check`.** SQLite cannot add or change
 * a column constraint in place, so any such change is the documented
 * create-copy-drop-rename dance — and with foreign keys enforced that is
 * impossible for a table anything references. `DROP TABLE` performs an
 * implicit `DELETE FROM` first, which trips the constraint immediately;
 * `PRAGMA defer_foreign_keys` only moves the failure to COMMIT, because
 * the deferred-violation counter the delete increments is never decremented
 * by the rename that puts the rows back. (`PRAGMA legacy_alter_table` is
 * worse still: it leaves the referencing table pointing at the renamed-aside
 * original, which is then dropped — a dangling reference and a corrupt
 * schema.) Disabling enforcement and verifying the whole graph afterwards
 * is SQLite's own recommended procedure, and `foreign_key_check` is
 * strictly stronger than incremental enforcement: it validates every row,
 * not just the ones this migration happened to touch.
 *
 * The pragma is a no-op inside a transaction, so it must be toggled out
 * here rather than from a migration's own SQL, and it is only touched when
 * there is actually something to apply.
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

  if (pending.length === 0) return;

  const foreignKeysWereOn = db.pragma("foreign_keys", { simple: true }) === 1;
  db.pragma("foreign_keys = OFF");

  try {
    for (const filename of pending) {
      const sql = readFileSync(path.join(migrationsDir, filename), "utf8");
      const applyOne = db.transaction(() => {
        db.exec(sql);
        assertForeignKeysIntact(db, filename);
        db.prepare("INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)").run(
          filename,
          new Date().toISOString(),
        );
      });
      applyOne();
      logger?.debug({ filename, migrationsDir }, "migration applied");
    }
  } finally {
    if (foreignKeysWereOn) db.pragma("foreign_keys = ON");
  }
}

/**
 * Runs inside the migration's own transaction, so a violation rolls the
 * whole file back rather than leaving a half-migrated schema behind. This
 * is what replaces the per-statement enforcement disabled above — without
 * it, a migration that genuinely orphaned rows would commit silently.
 */
function assertForeignKeysIntact(db: Database.Database, filename: string): void {
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length === 0) return;
  throw new Error(
    `migration "${filename}" left ${violations.length} foreign key violation(s): ` +
      `${JSON.stringify(violations.slice(0, 5))}${violations.length > 5 ? " ..." : ""}`,
  );
}
