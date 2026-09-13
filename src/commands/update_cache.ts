import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Command, OptionValues } from "commander";
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
import { IgnorePoliciesRepository } from "../db/repositories/ignore-policies-repository.js";
import { performUpdateCache, type UpdateCacheStats } from "../fs/update-cache.js";
import { createConcurrencyPools } from "../concurrency/pools.js";
import {
  resolveConcurrencyOptions,
  type GlobalConcurrencyOptions,
} from "../cli/concurrency-options.js";
import { shouldShowProgress, startProgressSession, createLoggerForRun } from "../cli/progress.js";

interface UpdateCacheOptions extends OptionValues {
  root: string;
}

interface GlobalOptions extends GlobalConcurrencyOptions {
  json?: boolean;
  verbose?: boolean;
  progress?: boolean;
}

export function registerUpdateCacheCommand(program: Command): void {
  program
    .command("update_cache")
    .description("Scan the local root directory and refresh cache.db to match the filesystem")
    .requiredOption("--root <path>", "local directory to scan")
    .action(async (opts: UpdateCacheOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const showProgress = shouldShowProgress({ json, progress: globalOpts.progress ?? true });
      const logger = createLoggerForRun({
        verbose: globalOpts.verbose ?? false,
        showProgress,
      }).child({ command: "update_cache" });

      try {
        const stats = await runUpdateCache(opts, globalOpts, logger, showProgress);
        const ok = stats.caseCollisions.length === 0;
        if (json) {
          emitJson({
            ok,
            created: stats.created,
            modified: stats.modified,
            deleted: stats.deleted,
            unchanged: stats.unchanged,
            ignored: stats.ignored,
            case_collisions: stats.caseCollisions.map((c) => ({
              path: c.path,
              collides_with: c.collidesWith,
            })),
          });
        } else {
          process.stdout.write(
            `update_cache: ${stats.created} created, ${stats.modified} modified, ${stats.deleted} deleted, ${stats.unchanged} unchanged, ${stats.ignored} ignored\n`,
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
  globalOpts: GlobalOptions,
  logger: import("../logger.js").Logger,
  showProgress: boolean,
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
  const ignorePoliciesRepo = new IgnorePoliciesRepository(stateDb);

  const pools = createConcurrencyPools(resolveConcurrencyOptions(globalOpts));
  const progress = startProgressSession({
    show: showProgress,
    overallLabel: "scanning",
    overallUnit: "entries",
  });
  progress.setOverallTotal(Math.max(cacheRepo.count(), 1));

  try {
    const stats = await performUpdateCache(
      root,
      localCacheDbPath(root),
      cacheRepo,
      objectsRepo,
      ignorePoliciesRepo,
      lastSyncedVersion,
      logger,
      pools.hash,
      pools.hash.maxThreads,
      (n) => {
        progress.setOverallTotal(n);
        progress.advanceOverall(1);
      },
    );
    return stats;
  } finally {
    progress.stop();
    await pools.hash.close();
    db.close();
    stateDb.close();
  }
}
