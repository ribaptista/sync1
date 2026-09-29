import fs from "node:fs";
import type { Command, OptionValues } from "commander";
import type { Logger } from "../logger.js";
import {
  emitJson,
  emitError,
  exitCodeForError,
  EXIT_CONFLICT,
  EXIT_GENERIC_ERROR,
} from "../cli/output.js";
import { getPassword } from "../cli/password.js";
import { createS3Client } from "../s3/client.js";
import { parseManifest, unlockVault } from "../vault/manifest.js";
import { parseRemoteConfig, type RemoteConfig } from "../vault/remote-config.js";
import { resolveMirrorPath } from "../vault/mirror-paths.js";
import type { MirrorOptions } from "../sync/apply-local-changes.js";
import { localVaultJsonPath, localRemoteConfigPath } from "../vault/local-dir.js";
import { resolveRoot } from "../cli/resolve-root.js";
import { normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import { performSync, RemoteDivergedError, type SyncResult } from "../sync/commit.js";
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

interface SyncOptions extends OptionValues {
  root?: string;
  verifyRemote?: boolean;
  skipMirror?: boolean;
  onMirrorMaxRetries?: string;
}

type OnMirrorMaxRetriesOption = "fail" | "ignore";

interface GlobalOptions extends GlobalConcurrencyOptions {
  json?: boolean;
  verbose?: boolean;
  progress?: boolean;
}

export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .description("Sync local changes with the remote vault")
    .option(
      "--root <path>",
      "local directory to sync (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .option(
      "--verify-remote",
      "HEAD-check S3 before every upload, even without a prior aborted run's marker present -- slower, but confirms nothing is silently missing",
    )
    .option("--skip-mirror", "ignore the configured mirror_path entirely for this run")
    .option(
      "--on-mirror-max-retries <fail|ignore>",
      "what a mirror write that has exhausted its retries means: 'fail' leaves the object uncommitted and its row dirty (default), 'ignore' commits to S3 anyway and leaves the gap for `mirror catchup`",
      "fail",
    )
    .action(async (opts: SyncOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const showProgress = shouldShowProgress({ json, progress: globalOpts.progress ?? true });
      const logger = createLoggerForRun({
        verbose: globalOpts.verbose ?? false,
        showProgress,
      }).child({ command: "sync" });

      try {
        const result = await runSync(opts, globalOpts, logger, showProgress);
        const hasConflicts = result.conflicts.length > 0;
        const hasCaseCollisions = result.caseCollisions.length > 0;
        const hasFailed = result.failed.length > 0;
        const hasIssues = hasConflicts || hasCaseCollisions || hasFailed;

        if (json) {
          emitJson({
            ok: !hasIssues,
            version_stamp: result.versionStamp,
            nothing_to_sync: result.nothingToSync,
            uploaded_objects: result.uploadedObjects,
            deduped_objects: result.dedupedObjects,
            mirrored_objects: result.mirroredObjects,
            mirror_failures: result.mirrorFailures,
            local_entries_changed: result.localEntriesChanged,
            remote_created: result.remoteCreated,
            remote_modified: result.remoteModified,
            remote_deleted: result.remoteDeleted,
            conflicts: result.conflicts,
            failed: result.failed,
            case_collisions: result.caseCollisions.map((c) => ({
              path: c.path,
              collides_with: c.collidesWith,
            })),
            ignored_but_synced: result.ignoredButSynced.map((c) => ({
              path: c.path,
              matched_glob: c.matchedGlob,
            })),
            dropped_ignored: result.droppedIgnored,
          });
        } else if (result.nothingToSync) {
          process.stdout.write("sync: nothing to sync\n");
        } else {
          process.stdout.write(
            `sync: version ${result.versionStamp} -- ${result.uploadedObjects} objects uploaded, ${result.dedupedObjects} deduped, ${result.localEntriesChanged} local entries changed, ${result.remoteCreated} remote created, ${result.remoteModified} remote modified, ${result.remoteDeleted} remote deleted\n`,
          );
          if (result.mirroredObjects > 0 || result.mirrorFailures > 0) {
            process.stdout.write(
              `  mirror: ${result.mirroredObjects} object(s) written` +
                (result.mirrorFailures > 0
                  ? `, ${result.mirrorFailures} skipped after exhausting retries -- run \`sync1 mirror catchup\`\n`
                  : "\n"),
            );
          }
          if (hasConflicts) {
            process.stdout.write(`${result.conflicts.length} conflict(s) left unresolved:\n`);
            for (const c of result.conflicts) process.stdout.write(`  - ${c.path}: ${c.reason}\n`);
          }
          if (hasFailed) {
            process.stdout.write(
              `${result.failed.length} upload(s) failed and were left dirty for the next sync:\n`,
            );
            for (const f of result.failed) process.stdout.write(`  - ${f.path}: ${f.error}\n`);
          }
          if (hasCaseCollisions) {
            process.stdout.write(
              `${result.caseCollisions.length} case-insensitive collision(s) detected (not synced):\n`,
            );
            for (const c of result.caseCollisions) {
              process.stdout.write(`  - "${c.path}" vs "${c.collidesWith}"\n`);
            }
          }
          if (result.ignoredButSynced.length > 0) {
            process.stdout.write(
              `warning: ${result.ignoredButSynced.length} path(s) matched a global ignore policy but were already shared, so materialized anyway:\n`,
            );
            for (const c of result.ignoredButSynced) {
              process.stdout.write(`  - "${c.path}" matches "${c.matchedGlob}"\n`);
            }
          }
          if (result.droppedIgnored.length > 0) {
            process.stdout.write(
              `${result.droppedIgnored.length} uncommitted path(s) dropped, now matching an ignore policy:\n`,
            );
            for (const p of result.droppedIgnored) {
              process.stdout.write(`  - "${p}"\n`);
            }
          }
        }

        // Conflicts/case-collisions are a human decision this run correctly
        // declined to make, and take priority over a plain failure when
        // both occur in the same run -- EXIT_CONFLICT either way. A run
        // with failed uploads but no conflicts is a different kind of
        // problem (this run tried and didn't succeed, not "waiting on a
        // human"), and gets the generic hard-failure code instead.
        if (hasConflicts || hasCaseCollisions) process.exitCode = EXIT_CONFLICT;
        else if (hasFailed) process.exitCode = EXIT_GENERIC_ERROR;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "sync failed");
        const exitCode = err instanceof RemoteDivergedError ? EXIT_CONFLICT : exitCodeForError(err);
        emitError(json, message, exitCode);
      }
    });
}

async function runSync(
  opts: SyncOptions,
  globalOpts: GlobalOptions,
  logger: Logger,
  showProgress: boolean,
): Promise<SyncResult> {
  const root = resolveRoot(opts.root);

  const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
  const password = await getPassword();
  const manifest = parseManifest(fs.readFileSync(localVaultJsonPath(root)));
  const masterKey = unlockVault(manifest, password);

  const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
  const prefix = normalizePrefix(remoteConfig.prefix);
  const location: RemoteLocation = { bucket: remoteConfig.bucket, prefix };

  const pools = createConcurrencyPools(resolveConcurrencyOptions(globalOpts));
  // "syncing" is only the fallback label: sync never reports against the
  // session's own bar, it mints one per phase below, so that bar stays
  // unborn. No file-count pre-seed either -- each phase enumerates its own
  // real total now, and last run's cache.db row count was never a
  // denominator for this run's work.
  const progress = startBytesProgressSession({ show: showProgress, overallLabel: "syncing" });

  try {
    return await performSync(
      root,
      masterKey,
      { client, bucket: remoteConfig.bucket, location },
      logger,
      pools,
      (label) => reporterFor(progress.startPhase(label)),
      opts.verifyRemote ?? false,
      mirrorOptions(opts, remoteConfig, root),
    );
  } finally {
    progress.stop();
    await pools.hash.close();
  }
}

/**
 * Resolves what, if anything, this run mirrors to.
 *
 * `--skip-mirror` wins over a configured path, and is the deliberate
 * escape hatch when the drive is away. Note what it leaves behind: objects
 * committed to S3 with no second copy, which is exactly the state
 * `stubify`'s mirror gate exists to refuse to act on.
 */
function mirrorOptions(opts: SyncOptions, remoteConfig: RemoteConfig, root: string): MirrorOptions {
  const onMaxRetries = parseOnMirrorMaxRetries(opts.onMirrorMaxRetries);
  if (opts.skipMirror) return { path: undefined, onMaxRetries };
  return { path: resolveMirrorPath(remoteConfig, root), onMaxRetries };
}

function parseOnMirrorMaxRetries(value: string | undefined): OnMirrorMaxRetriesOption {
  if (value === undefined || value === "fail") return "fail";
  if (value === "ignore") return "ignore";
  throw new Error(`--on-mirror-max-retries must be "fail" or "ignore", not "${value}"`);
}
