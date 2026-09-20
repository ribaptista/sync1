import type { Command, OptionValues } from "commander";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { localCacheDbPath } from "../vault/local-dir.js";
import { openCacheDb } from "../db/connection.js";
import { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import { stubifyGlob, type StubifyStats } from "../fs/stubify.js";
import { createConcurrencyPools } from "../concurrency/pools.js";
import {
  resolveConcurrencyOptions,
  type GlobalConcurrencyOptions,
} from "../cli/concurrency-options.js";
import {
  shouldShowProgress,
  startBytesProgressSession,
  createLoggerForRun,
  reporterFor,
} from "../cli/progress.js";
import { resolveRoot } from "../cli/resolve-root.js";

interface StubifyOptions extends OptionValues {
  root?: string;
}

interface GlobalOptions extends GlobalConcurrencyOptions {
  json?: boolean;
  verbose?: boolean;
  progress?: boolean;
}

export function registerStubifyCommand(program: Command): void {
  program
    .command("stubify")
    .description("Replace fully-committed real files matching a glob pattern with stubs")
    .argument("<glob>", "glob pattern matched against tracked paths")
    .option(
      "--root <path>",
      "local directory to operate on (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .action(async (glob: string, opts: StubifyOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const showProgress = shouldShowProgress({ json, progress: globalOpts.progress ?? true });
      const logger = createLoggerForRun({
        verbose: globalOpts.verbose ?? false,
        showProgress,
      }).child({ command: "stubify" });

      try {
        const stats = await runStubify(glob, opts, globalOpts, logger, showProgress);
        if (json) {
          emitJson({
            ok: stats.skipped.length === 0,
            stubified: stats.stubified,
            already_stub: stats.alreadyStub,
            thumbnail_dir_excluded: stats.thumbnailDirExcluded,
            skipped: stats.skipped,
          });
        } else {
          process.stdout.write(
            `stubify: ${stats.stubified} stubified, ${stats.alreadyStub} already stub, ` +
              `${stats.thumbnailDirExcluded} thumbnail dir excluded\n`,
          );
          for (const s of stats.skipped) process.stdout.write(`  skipped ${s.path}: ${s.reason}\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "stubify failed");
        emitError(json, message, exitCodeForError(err));
      }
    });
}

async function runStubify(
  glob: string,
  opts: StubifyOptions,
  globalOpts: GlobalOptions,
  logger: import("../logger.js").Logger,
  showProgress: boolean,
): Promise<StubifyStats> {
  const root = resolveRoot(opts.root);

  const cacheDb = openCacheDb(localCacheDbPath(root), logger);
  const pools = createConcurrencyPools(resolveConcurrencyOptions(globalOpts));
  const progress = startBytesProgressSession({ show: showProgress, overallLabel: "stubifying" });

  try {
    const cacheRepo = new CacheEntriesRepository(cacheDb);
    progress.setOverallTotals({ files: Math.max(cacheRepo.count(), 1) });
    return await stubifyGlob(
      root,
      glob,
      cacheRepo,
      logger,
      pools.hashRunner,
      pools.hash.maxThreads,
      reporterFor(progress),
    );
  } finally {
    progress.stop();
    await pools.hash.close();
    cacheDb.close();
  }
}
