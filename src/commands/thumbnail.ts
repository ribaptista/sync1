import type { Command, OptionValues } from "commander";
import { emitJson, emitError, exitCodeForError, EXIT_GENERIC_ERROR } from "../cli/output.js";
import { localCacheDbPath, localStateDbPath } from "../vault/local-dir.js";
import { openCacheDbReadOnly, openStateDbReadOnly } from "../db/connection.js";
import { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import { ThumbnailPoliciesRepository } from "../db/repositories/thumbnail-policies-repository.js";
import { scanThumbnails, type ThumbnailRunMode, type ThumbnailScanStats } from "../fs/thumbnail.js";
import { realMediaProber } from "../media/probe.js";
import { realThumbnailGenerator } from "../media/thumbnail-generate.js";
import { createConcurrencyPools } from "../concurrency/pools.js";
import {
  resolveConcurrencyOptions,
  type GlobalConcurrencyOptions,
} from "../cli/concurrency-options.js";
import { shouldShowProgress, startProgressSession, createLoggerForRun } from "../cli/progress.js";
import { resolveRoot } from "../cli/resolve-root.js";
import type { Logger } from "../logger.js";

interface ThumbnailRunOptions extends OptionValues {
  root?: string;
  glob?: string;
  deleteStaleStubPreviews?: boolean;
}

interface GlobalOptions extends GlobalConcurrencyOptions {
  json?: boolean;
  verbose?: boolean;
  progress?: boolean;
}

/**
 * Shared runner for all three subcommands -- local-only, no password/S3
 * client, same as `update_cache`/`sanity_check`: cache.db and state.db are
 * opened read-only (this command never writes either), only the local
 * filesystem is touched (a `_thumbnail/` file written or deleted).
 */
async function runThumbnailMode(
  mode: ThumbnailRunMode,
  opts: ThumbnailRunOptions,
  globalOpts: GlobalOptions,
  logger: Logger,
  showProgress: boolean,
): Promise<ThumbnailScanStats> {
  const root = resolveRoot(opts.root);

  const cacheDb = openCacheDbReadOnly(localCacheDbPath(root));
  const cacheRepo = new CacheEntriesRepository(cacheDb);
  const stateDb = openStateDbReadOnly(localStateDbPath(root));
  const policiesRepo = new ThumbnailPoliciesRepository(stateDb);

  const pools = createConcurrencyPools(resolveConcurrencyOptions(globalOpts));
  const progress = startProgressSession({
    show: showProgress,
    overallLabel: `thumbnail ${mode}`,
    overallUnit: "files",
  });

  // `ensure` drives the one bar from its generation phase instead of the
  // scan phase -- see scanThumbnails's own doc comment on
  // onGenerationProgress for why these are separate callbacks, not one
  // shared cumulative count. `state`/`cleanup` never generate anything,
  // so "files scanned" stays their progress unit -- but its denominator
  // now comes from the concurrent counting walk rather than from the
  // scanned count standing in for its own total.
  let lastGenerated = 0;

  try {
    return await scanThumbnails(
      root,
      mode,
      opts.glob,
      cacheRepo,
      policiesRepo.list(),
      realMediaProber,
      realThumbnailGenerator,
      logger,
      pools.thumbnail,
      pools.thumbnail.concurrency * 2,
      opts.deleteStaleStubPreviews ?? false,
      mode === "ensure"
        ? undefined
        : (n) => {
            // setOverallTotal stays as a floor: if the counting walk fails
            // or falls behind, the bar still can't claim more progress
            // than total. The real denominator arrives via the
            // onScanTotalKnown callback below.
            progress.setOverallTotal(n);
            progress.advanceOverall(1);
          },
      mode === "ensure"
        ? (total, generated) => {
            // `final: true` from the very first call: every candidate is
            // known before the first one is dispatched, so this total is
            // exact, not a running discovery count.
            progress.setOverallTotal(total, { final: true });
            if (generated > lastGenerated) {
              progress.advanceOverall(generated - lastGenerated);
              lastGenerated = generated;
            }
          }
        : undefined,
      mode === "ensure" ? undefined : (total, final) => progress.setOverallTotal(total, { final }),
    );
  } finally {
    progress.stop();
    await pools.hash.close();
    cacheDb.close();
    stateDb.close();
  }
}

function emitStats(json: boolean, mode: ThumbnailRunMode, stats: ThumbnailScanStats): boolean {
  const ok = stats.errors === 0 && stats.staleStubPreviews.length === 0;
  if (json) {
    emitJson({
      ok,
      up_to_date: stats.upToDate,
      to_generate: stats.toGenerate,
      to_regenerate: stats.toRegenerate,
      to_delete: stats.toDelete,
      missing_cache_entry: stats.missingCacheEntry,
      stubbed_original: stats.stubbedOriginal,
      stubbed_preserved: stats.stubbedPreserved,
      stale_stub_previews: stats.staleStubPreviews.map((s) => ({
        path: s.path,
        thumbnail_path: s.thumbnailPath,
      })),
      errors: stats.errors,
    });
  } else {
    process.stdout.write(
      `thumbnail ${mode}: ${stats.upToDate} up to date, ${stats.toGenerate} to generate, ` +
        `${stats.toRegenerate} to regenerate, ${stats.toDelete} to delete, ` +
        `${stats.missingCacheEntry} missing cache entry, ${stats.stubbedOriginal} stubbed original, ` +
        `${stats.stubbedPreserved} stubbed preserved, ${stats.staleStubPreviews.length} stale stub preview(s), ` +
        `${stats.errors} error(s)\n`,
    );
    for (const s of stats.staleStubPreviews) {
      process.stdout.write(
        `  stale stub preview: "${s.path}" -> "${s.thumbnailPath}" -- stub content changed since this thumbnail was generated; materialize and regenerate, or pass --delete-stale-stub-previews to cleanup to discard it\n`,
      );
    }
  }
  return ok;
}

function registerThumbnailSubcommand(
  thumbnail: Command,
  mode: ThumbnailRunMode,
  description: string,
): void {
  const command = thumbnail
    .command(mode)
    .description(description)
    .option(
      "--root <path>",
      "local directory to scan (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .option("--glob <pattern>", "glob pattern scoping which files to consider");

  // Only `cleanup` ever deletes anything, so this is the only subcommand
  // where the flag would mean something -- see scanThumbnails's own doc
  // comment for why it isn't implied by `mode === "cleanup"` alone.
  if (mode === "cleanup") {
    command.option(
      "--delete-stale-stub-previews",
      "also delete a stubbed original's existing thumbnail when the stub's content hash no longer matches it (unregenerable without materializing the file first)",
    );
  }

  command.action(async (opts: ThumbnailRunOptions, cmd: Command) => {
    const globalOpts = cmd.optsWithGlobals<GlobalOptions>();
    const json = globalOpts.json ?? false;
    const showProgress = shouldShowProgress({ json, progress: globalOpts.progress ?? true });
    const logger = createLoggerForRun({
      verbose: globalOpts.verbose ?? false,
      showProgress,
    }).child({ command: `thumbnail_${mode}` });

    try {
      const stats = await runThumbnailMode(mode, opts, globalOpts, logger, showProgress);
      const ok = emitStats(json, mode, stats);
      if (!ok) process.exitCode = EXIT_GENERIC_ERROR;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug({ err: message }, `thumbnail ${mode} failed`);
      emitError(json, message, exitCodeForError(err));
    }
  });
}

export function registerThumbnailCommand(program: Command): void {
  const thumbnail = program
    .command("thumbnail")
    .description("Generate and manage low-resolution thumbnails/mosaics for images and videos");

  registerThumbnailSubcommand(
    thumbnail,
    "state",
    "Report thumbnail status without writing anything (read-only)",
  );
  registerThumbnailSubcommand(
    thumbnail,
    "ensure",
    "Generate missing/stale thumbnails (never deletes extras -- see cleanup)",
  );
  registerThumbnailSubcommand(
    thumbnail,
    "cleanup",
    "Delete extra thumbnails (skip-matched or orphaned -- never generates)",
  );
}
