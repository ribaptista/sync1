import fs from "node:fs";
import type { Command, OptionValues } from "commander";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { createS3Client } from "../s3/client.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import { localRemoteConfigPath } from "../vault/local-dir.js";
import { normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import { convergeStoragePolicies, type ConvergeResult } from "../sync/converge-storage-policies.js";
import { createConcurrencyPools } from "../concurrency/pools.js";
import {
  resolveConcurrencyOptions,
  type GlobalConcurrencyOptions,
} from "../cli/concurrency-options.js";
import { shouldShowProgress, startProgressSession, createLoggerForRun } from "../cli/progress.js";
import { resolveRoot } from "../cli/resolve-root.js";

interface ConvergeOptions extends OptionValues {
  root?: string;
  filter?: string;
}

interface GlobalOptions extends GlobalConcurrencyOptions {
  json?: boolean;
  verbose?: boolean;
  progress?: boolean;
}

export function registerConvergeCommand(program: Command): void {
  program
    .command("converge")
    .description(
      "Apply storage_policy: move each tracked object's actual S3 storage class to match what the policies imply",
    )
    .option(
      "--root <path>",
      "local directory whose vault to operate on (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .option("--filter <glob>", "glob pattern scoping which tracked paths to converge", "*")
    .action(async (opts: ConvergeOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const showProgress = shouldShowProgress({ json, progress: globalOpts.progress ?? true });
      const logger = createLoggerForRun({
        verbose: globalOpts.verbose ?? false,
        showProgress,
      }).child({ command: "converge" });

      try {
        const result = await runConverge(opts, globalOpts, logger, showProgress);
        if (json) {
          emitJson({
            ok: true,
            already_correct: result.counts.alreadyCorrect,
            changed_immediate: result.counts.changedImmediate,
            restore_requested: result.counts.restoreRequested,
            restore_pending: result.counts.restorePending,
            finalized: result.counts.finalized,
            conflicts: result.conflicts.map((c) => ({
              hash: c.hash,
              paths: c.paths,
              target_class: c.targetClass,
            })),
          });
        } else {
          process.stdout.write(
            `converge: ${result.counts.alreadyCorrect} already correct, ${result.counts.changedImmediate} changed immediately, ${result.counts.restoreRequested} restore requested, ${result.counts.restorePending} restore pending, ${result.counts.finalized} finalized\n`,
          );
          if (result.conflicts.length > 0) {
            process.stdout.write(
              `${result.conflicts.length} dedup warmest-wins conflict(s) (shared object, disagreeing policies -- converged to the warmest):\n`,
            );
            for (const c of result.conflicts) {
              process.stdout.write(
                `  - ${c.hash} -> ${c.targetClass} (paths: ${c.paths.join(", ")})\n`,
              );
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "converge failed");
        emitError(json, message, exitCodeForError(err));
      }
    });
}

async function runConverge(
  opts: ConvergeOptions,
  globalOpts: GlobalOptions,
  logger: import("../logger.js").Logger,
  showProgress: boolean,
): Promise<ConvergeResult> {
  const root = resolveRoot(opts.root);
  const filter = opts.filter ?? "*";

  const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
  const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
  const prefix = normalizePrefix(remoteConfig.prefix);
  const location: RemoteLocation = { bucket: remoteConfig.bucket, prefix };

  const pools = createConcurrencyPools(resolveConcurrencyOptions(globalOpts));
  const progress = startProgressSession({
    show: showProgress,
    overallLabel: "converging",
    overallUnit: "objects",
  });

  try {
    return await convergeStoragePolicies(
      root,
      filter,
      true,
      { client, bucket: remoteConfig.bucket, location },
      logger,
      pools.s3,
      pools.s3.concurrency * 2,
      (checked) => progress.setOverallProgress(checked),
      (total) => progress.setOverallTotal(total, { final: true }),
    );
  } finally {
    progress.stop();
    await pools.hash.close();
  }
}
