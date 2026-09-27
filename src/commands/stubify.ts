import fs from "node:fs";
import type { Command, OptionValues } from "commander";
import { emitJson, emitError, exitCodeForError, EXIT_GENERIC_ERROR } from "../cli/output.js";
import { localCacheDbPath, localRemoteConfigPath } from "../vault/local-dir.js";
import { openCacheDb } from "../db/connection.js";
import { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import { resolveReachableMirrorIfConfigured } from "../vault/mirror-paths.js";
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
  allowUnmirrored?: boolean;
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
    .option(
      "--allow-unmirrored",
      "stub files whose content is not on the configured mirror -- by default those are skipped, since stubbing deletes the last local copy of something that then exists in only one place",
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
        // A skipped file is not a crash, but it is a failure: the glob was
        // asked to free disk space and didn't, for at least one path, and
        // AGENTS.md's "non-zero exit code on any failure" applies here as
        // much as to an outright error. This used to compute `ok` and
        // report it without ever touching `process.exitCode` -- every
        // other command with a per-item `ok` (thumbnail, mirror,
        // update_cache, sanity_check) sets one; stubify was the exception.
        const ok = stats.skipped.length === 0;
        if (json) {
          emitJson({
            ok,
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
        if (!ok) process.exitCode = EXIT_GENERIC_ERROR;
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
    // No `cacheRepo.count()` pre-seed any more: it counted every row in
    // the vault, not the glob-matched ones this run will touch, and said
    // nothing at all about bytes -- which is what actually drives the bar
    // and the ETA. stubifyGlob enumerates both for real now, concurrently
    // with the scan itself.
    return await stubifyGlob(
      root,
      glob,
      cacheRepo,
      logger,
      pools.hashRunner,
      pools.hash.maxThreads,
      reporterFor(progress),
      opts.allowUnmirrored ? undefined : resolveMirrorGate(root),
    );
  } finally {
    progress.stop();
    await pools.hash.close();
    cacheDb.close();
  }
}

/**
 * The mirror path to gate against, or `undefined` if there is nothing to
 * gate against.
 *
 * Deliberately **not** `mirrorPathFor` (the swallow-everything resolver
 * `sync`/`gc`/policy edits use): those callers must never let a bad
 * mirror config fail an otherwise-valid state commit, but stubify's gate
 * exists specifically to protect data, so the one thing it must not do is
 * proceed as if a mirror were healthy when it can't actually tell.
 *
 * "Not configured at all" still means "nothing to gate against" -- a
 * vault with no `mirror_path` behaves exactly as it always did. But a
 * `mirror_path` that IS configured and cannot currently be reached
 * (unmounted drive, dropped share, or simply malformed) throws, and that
 * exception is left to propagate out of `runStubify` uncaught: reading an
 * unreachable mirror as "everything is unmirrored" is precisely the
 * defect this replaces -- it used to skip every single row with a
 * reason that blamed the file when the drive was the actual problem.
 *
 * Reads only `remote.json`, never `state.db`, so stubify keeps needing
 * neither it nor the password.
 */
function resolveMirrorGate(root: string): string | undefined {
  const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
  return resolveReachableMirrorIfConfigured(remoteConfig, root);
}
