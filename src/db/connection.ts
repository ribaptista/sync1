import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations/runner.js";
import type { Logger } from "../logger.js";

// NOTE: migrations are loaded from .sql files on disk next to this module.
// The dev/test flow runs via tsx directly against src/, so this resolves
// correctly there. For a real `npm run build`, tsc doesn't copy non-.ts
// assets on its own -- the "postbuild" script (scripts/copy-migrations.js)
// copies src/db/migrations/{state,cache}/*.sql into dist/db/migrations/.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function openStateDb(filePath: string, logger?: Logger): Database.Database {
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db, path.join(MODULE_DIR, "migrations", "state"), logger);
  return db;
}

export function openCacheDb(filePath: string, logger?: Logger): Database.Database {
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  runMigrations(db, path.join(MODULE_DIR, "migrations", "cache"), logger);
  return db;
}
