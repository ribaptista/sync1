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

// Shared by every opener below -- cheap regardless of durability tier, so
// there's no tradeoff in applying them uniformly (unlike `synchronous`,
// which genuinely differs by how expendable each database's writes are).
function applyCommonPragmas(db: Database.Database): void {
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -64000"); // 64 MiB; negative means KiB, per SQLite's own convention
  db.pragma("busy_timeout = 5000");
}

export function openStateDb(filePath: string, logger?: Logger): Database.Database {
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // state.db is the one durable database in this app -- synced to S3, the
  // source every machine reconstructs from -- and its writes are rare (one
  // commit per sync), so FULL costs nothing worth trading away. Unlike
  // cache.db and the staging DB, this is the existing default made
  // explicit, not a change.
  db.pragma("synchronous = FULL");
  applyCommonPragmas(db);
  runMigrations(db, path.join(MODULE_DIR, "migrations", "state"), logger);
  return db;
}

export function openCacheDb(filePath: string, logger?: Logger): Database.Database {
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  // cache.db is fully regenerable from the filesystem by a fresh
  // update_cache -- it is a local, unencrypted index, never synced -- so
  // losing the last few fsyncs of a crash mid-write costs a rescan, not
  // data. NORMAL (vs. FULL) is the standard tradeoff for that case under
  // WAL: still crash-safe against corruption, just not against losing the
  // most recent commits.
  db.pragma("synchronous = NORMAL");
  applyCommonPragmas(db);
  runMigrations(db, path.join(MODULE_DIR, "migrations", "cache"), logger);
  return db;
}

/**
 * Shared opener for the many read-only `state.db` handles scattered across
 * command modules (validating stub hashes, listing policies, and similar
 * lookups that need no write access and no password, since state.db sits
 * fully decrypted on disk once synced). Before this, each call site did its
 * own bare `new Database(path, { readonly: true, fileMustExist: true })`,
 * which gets none of the pragmas above -- harmless for `synchronous` (a
 * read-only connection never writes), but `cache_size`/`temp_store` still
 * speed up the large sequential/aggregate reads a couple of these call
 * sites do (`sanity_check`, `converge-storage-policies`).
 */
export function openStateDbReadOnly(filePath: string): Database.Database {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  applyCommonPragmas(db);
  return db;
}

/** As {@link openStateDbReadOnly}, for the one read-only `cache.db` handle (`thumbnail.ts`). */
export function openCacheDbReadOnly(filePath: string): Database.Database {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  applyCommonPragmas(db);
  return db;
}
