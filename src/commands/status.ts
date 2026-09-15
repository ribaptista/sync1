import fs from "node:fs";
import path from "node:path";
import type { Command, OptionValues } from "commander";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { createS3Client } from "../s3/client.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import { sync1Dir, localRemoteConfigPath } from "../vault/local-dir.js";
import { normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import { convergeStoragePolicies, type ConvergeResult } from "../sync/converge-storage-policies.js";
import { createConcurrencyPools } from "../concurrency/pools.js";
import {
  resolveConcurrencyOptions,
  type GlobalConcurrencyOptions,
} from "../cli/concurrency-options.js";
import { shouldShowProgress, startProgressSession, createLoggerForRun } from "../cli/progress.js";

interface StatusOptions extends OptionValues {
  root: string;
  filter?: string;
}

interface GlobalOptions extends GlobalConcurrencyOptions {
  json?: boolean;
  verbose?: boolean;
  progress?: boolean;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description(
      "Report how each tracked object's actual S3 storage class compares to what storage_policy implies",
    )
    .requiredOption("--root <path>", "local directory whose vault to inspect")
    .option("--filter <glob>", "glob pattern scoping which tracked paths to consider", "*")
    .action(async (opts: StatusOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const showProgress = shouldShowProgress({ json, progress: globalOpts.progress ?? true });
      const logger = createLoggerForRun({
        verbose: globalOpts.verbose ?? false,
        showProgress,
      }).child({ command: "status" });

      try {
        const result = await runStatus(opts, globalOpts, logger, showProgress);
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
            `status: ${result.counts.alreadyCorrect} already correct, ${result.counts.changedImmediate} need an immediate copy, ${result.counts.restoreRequested} need a restore request, ${result.counts.restorePending} restore pending, ${result.counts.finalized} ready to finalize\n`,
          );
          if (result.conflicts.length > 0) {
            process.stdout.write(
              `${result.conflicts.length} dedup warmest-wins conflict(s) (shared object, disagreeing policies):\n`,
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
        logger.debug({ err: message }, "status failed");
        emitError(json, message, exitCodeForError(err));
      }
    });
}

async function runStatus(
  opts: StatusOptions,
  globalOpts: GlobalOptions,
  logger: import("../logger.js").Logger,
  showProgress: boolean,
): Promise<ConvergeResult> {
  const root = path.resolve(opts.root);
  const sync1DirPath = sync1Dir(root);
  if (!fs.existsSync(sync1DirPath)) {
    throw new Error(`"${sync1DirPath}" does not exist — run init_remote or attach_remote first`);
  }
  const filter = opts.filter ?? "*";

  const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
  const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
  const prefix = normalizePrefix(remoteConfig.prefix);
  const location: RemoteLocation = { bucket: remoteConfig.bucket, prefix };

  const pools = createConcurrencyPools(resolveConcurrencyOptions(globalOpts));
  const progress = startProgressSession({
    show: showProgress,
    overallLabel: "checking",
    overallUnit: "objects",
  });

  try {
    return await convergeStoragePolicies(
      root,
      filter,
      false,
      { client, bucket: remoteConfig.bucket, location },
      logger,
      pools.s3,
      pools.s3.concurrency * 2,
      (n) => {
        progress.setOverallTotal(n);
        progress.advanceOverall(1);
      },
    );
  } finally {
    progress.stop();
    await pools.hash.close();
  }
}
