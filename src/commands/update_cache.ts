import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Command, OptionValues } from "commander";
import { createLogger, type Logger } from "../logger.js";
import { emitJson, emitError, exitCodeForError, EXIT_GENERIC_ERROR } from "../cli/output.js";
import {
  sync1Dir,
  localCacheDbPath,
  localStateDbPath,
  lastSyncedVersionPath,
} from "../vault/local-dir.js";
import { openCacheDb } from "../db/connection.js";
import { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { performUpdateCache, type UpdateCacheStats } from "../fs/update-cache.js";

interface UpdateCacheOptions extends OptionValues {
  root: string;
}

interface GlobalOptions extends OptionValues {
  json?: boolean;
  verbose?: boolean;
}

export function registerUpdateCacheCommand(program: Command): void {
  program
    .command("update_cache")
    .description("Scan the local root directory and refresh cache.db to match the filesystem")
    .requiredOption("--root <path>", "local directory to scan")
    .action(async (opts: UpdateCacheOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "update_cache" });

      try {
        const stats = await runUpdateCache(opts, logger, json);
        const ok = stats.caseCollisions.length === 0;
        if (json) {
          emitJson({
            ok,
            created: stats.created,
            modified: stats.modified,
            deleted: stats.deleted,
            unchanged: stats.unchanged,
            case_collisions: stats.caseCollisions.map((c) => ({
              path: c.path,
              collides_with: c.collidesWith,
            })),
          });
        } else {
          process.stdout.write(
            `update_cache: ${stats.created} created, ${stats.modified} modified, ${stats.deleted} deleted, ${stats.unchanged} unchanged\n`,
          );
          for (const c of stats.caseCollisions) {
            process.stdout.write(
              `  case collision: "${c.path}" vs "${c.collidesWith}" -- rename or remove one of them, then run update_cache again\n`,
            );
          }
        }
        if (!ok) process.exitCode = EXIT_GENERIC_ERROR;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "update_cache failed");
        emitError(json, message, exitCodeForError(err));
      }
    });
}

async function runUpdateCache(
  opts: UpdateCacheOptions,
  logger: Logger,
  json: boolean,
): Promise<UpdateCacheStats> {
  const root = path.resolve(opts.root);
  const sync1DirPath = sync1Dir(root);
  if (!fs.existsSync(sync1DirPath)) {
    throw new Error(`"${sync1DirPath}" does not exist — run init_remote or attach_remote first`);
  }

  const lastSyncedVersion = fs.readFileSync(lastSyncedVersionPath(root), "utf8").trim();
  const db = openCacheDb(localCacheDbPath(root), logger);
  const cacheRepo = new CacheEntriesRepository(db);
  // Read-only: only used to validate stub-declared hashes against known
  // objects. Local state.db is already decrypted on disk, so this needs no
  // password.
  const stateDb = new Database(localStateDbPath(root), { readonly: true, fileMustExist: true });
  const objectsRepo = new ObjectsRepository(stateDb);

  let bar: import("cli-progress").SingleBar | undefined;
  if (!json) {
    const { SingleBar, Presets } = await import("cli-progress");
    bar = new SingleBar({ format: "scanning |{bar}| {value} entries" }, Presets.shades_classic);
    bar.start(Math.max(cacheRepo.count(), 1), 0);
  }

  const stats = await performUpdateCache(
    root,
    localCacheDbPath(root),
    cacheRepo,
    objectsRepo,
    lastSyncedVersion,
    logger,
    (n) => {
      if (bar) {
        if (n > bar.getTotal()) bar.setTotal(n);
        bar.update(n);
      }
    },
  );

  bar?.stop();
  db.close();
  stateDb.close();
  return stats;
}
