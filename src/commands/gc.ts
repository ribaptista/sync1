import fs from "node:fs";
import type { Command, OptionValues } from "commander";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { getPassword } from "../cli/password.js";
import { createS3Client } from "../s3/client.js";
import { parseManifest, unlockVault } from "../vault/manifest.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import { localVaultJsonPath, localRemoteConfigPath } from "../vault/local-dir.js";
import { normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import { performGc, type GcResult } from "../sync/gc.js";
import { createConcurrencyPools } from "../concurrency/pools.js";
import {
  resolveConcurrencyOptions,
  type GlobalConcurrencyOptions,
} from "../cli/concurrency-options.js";
import { shouldShowProgress, startProgressSession, createLoggerForRun } from "../cli/progress.js";
import { resolveRoot } from "../cli/resolve-root.js";

interface GcOptions extends OptionValues {
  root?: string;
  apply?: boolean;
}

interface GlobalOptions extends GlobalConcurrencyOptions {
  json?: boolean;
  verbose?: boolean;
  progress?: boolean;
}

export function registerGcCommand(program: Command): void {
  program
    .command("gc")
    .description("Remove S3 objects no longer referenced by any current entry")
    .option(
      "--root <path>",
      "local directory whose vault to clean up (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .option("--apply", "actually delete orphaned objects (default: count only)")
    .action(async (opts: GcOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const showProgress = shouldShowProgress({ json, progress: globalOpts.progress ?? true });
      const logger = createLoggerForRun({
        verbose: globalOpts.verbose ?? false,
        showProgress,
      }).child({ command: "gc" });

      try {
        const result = await runGc(opts, globalOpts, logger);
        if (json) {
          emitJson({
            ok: true,
            applied: result.applied,
            orphan_count: result.orphanCount,
            reclaimed_bytes: result.reclaimedBytes,
          });
        } else {
          const mode = result.applied ? "removed" : "counted (pass --apply to remove)";
          process.stdout.write(
            `gc (${mode}): ${result.orphanCount} orphans, ${result.reclaimedBytes} bytes\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "gc failed");
        emitError(json, message, exitCodeForError(err));
      }
    });
}

async function runGc(
  opts: GcOptions,
  globalOpts: GlobalOptions,
  logger: import("../logger.js").Logger,
): Promise<GcResult> {
  const root = resolveRoot(opts.root);

  const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
  const password = await getPassword();
  const manifest = parseManifest(fs.readFileSync(localVaultJsonPath(root)));
  const masterKey = unlockVault(manifest, password);

  const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
  const prefix = normalizePrefix(remoteConfig.prefix);
  const location: RemoteLocation = { bucket: remoteConfig.bucket, prefix };

  const pools = createConcurrencyPools(resolveConcurrencyOptions(globalOpts));
  const showProgress = shouldShowProgress({
    json: globalOpts.json ?? false,
    progress: globalOpts.progress ?? true,
  });
  const progress = startProgressSession({
    show: showProgress && (opts.apply ?? false),
    overallLabel: "removing orphans",
    overallUnit: "objects",
  });

  try {
    return await performGc(
      root,
      masterKey,
      { client, bucket: remoteConfig.bucket, location },
      opts.apply ?? false,
      logger,
      pools.s3,
      pools.s3.concurrency * 2,
      undefined,
      // Absolute count of completed deletes, not a delta -- the pool
      // resolves out of order, so only the callback's own running tally is
      // meaningful.
      (deleted) => progress.setOverallProgress(deleted),
      (total) => progress.setOverallTotal(total, { final: true }),
    );
  } finally {
    progress.stop();
    await pools.hash.close();
  }
}
