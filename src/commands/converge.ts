import fs from "node:fs";
import path from "node:path";
import type { Command, OptionValues } from "commander";
import { createLogger, type Logger } from "../logger.js";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { createS3Client } from "../s3/client.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import { sync1Dir, localRemoteConfigPath } from "../vault/local-dir.js";
import { normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import { convergeStoragePolicies, type ConvergeResult } from "../sync/converge-storage-policies.js";

interface ConvergeOptions extends OptionValues {
  root: string;
  filter?: string;
}

interface GlobalOptions extends OptionValues {
  json?: boolean;
  verbose?: boolean;
}

export function registerConvergeCommand(program: Command): void {
  program
    .command("converge")
    .description(
      "Apply storage_policy: move each tracked object's actual S3 storage class to match what the policies imply",
    )
    .requiredOption("--root <path>", "local directory whose vault to operate on")
    .option("--filter <glob>", "SQLite GLOB pattern scoping which tracked paths to converge", "*")
    .action(async (opts: ConvergeOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "converge" });

      try {
        const result = await runConverge(opts, logger);
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

async function runConverge(opts: ConvergeOptions, logger: Logger): Promise<ConvergeResult> {
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

  return convergeStoragePolicies(
    root,
    filter,
    true,
    { client, bucket: remoteConfig.bucket, location },
    logger,
  );
}
