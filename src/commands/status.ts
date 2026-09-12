import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Command, OptionValues } from "commander";
import { createLogger, type Logger } from "../logger.js";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { createS3Client, headObject } from "../s3/client.js";
import {
  classifyArchiveStatus,
  isSupportedStorageClass,
  type SupportedStorageClass,
} from "../s3/archive-status.js";
import { decideStorageClassAction } from "../s3/storage-class-actions.js";
import { resolveHashTargetClass } from "../s3/policy-evaluation.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import { sync1Dir, localStateDbPath, localRemoteConfigPath } from "../vault/local-dir.js";
import { remoteKey, normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import { EntriesRepository } from "../db/repositories/entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { StoragePoliciesRepository } from "../db/repositories/storage-policies-repository.js";
import { CorruptionError } from "../errors.js";

interface StatusOptions extends OptionValues {
  root: string;
  filter?: string;
}

interface GlobalOptions extends OptionValues {
  json?: boolean;
  verbose?: boolean;
}

export interface StatusCounts {
  alreadyCorrect: number;
  changedImmediate: number;
  restoreRequested: number;
  restorePending: number;
  finalized: number;
}

export interface StatusConflict {
  hash: string;
  paths: string[];
  targetClass: SupportedStorageClass;
}

export interface StatusResult {
  counts: StatusCounts;
  conflicts: StatusConflict[];
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description(
      "Report how each tracked object's actual S3 storage class compares to what storage_policy implies",
    )
    .requiredOption("--root <path>", "local directory whose vault to inspect")
    .option("--filter <glob>", "SQLite GLOB pattern scoping which tracked paths to consider", "*")
    .action(async (opts: StatusOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "status" });

      try {
        const result = await runStatus(opts, logger);
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

/**
 * Shared by `status` (report-only) and `converge` (Task SP5, which applies
 * the same evaluation). Read-only here: HEAD doesn't decrypt, and policies
 * are read from the already-locally-decrypted state.db -- same reasoning
 * `ensure_storage_class` already relies on.
 */
export async function runStatus(opts: StatusOptions, logger: Logger): Promise<StatusResult> {
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

  const db = new Database(localStateDbPath(root), { readonly: true, fileMustExist: true });
  const counts: StatusCounts = {
    alreadyCorrect: 0,
    changedImmediate: 0,
    restoreRequested: 0,
    restorePending: 0,
    finalized: 0,
  };
  const conflicts: StatusConflict[] = [];

  try {
    const entriesRepo = new EntriesRepository(db);
    const objectsRepo = new ObjectsRepository(db);
    const storagePoliciesRepo = new StoragePoliciesRepository(db);
    const nonDefaultPolicies = storagePoliciesRepo.listNonDefaultByPriority();
    const defaultPolicy = storagePoliciesRepo.getDefault();

    // Dedup interaction: this iterates distinct *hashes* with at least one
    // matching path, not paths themselves -- a shared object's target is
    // resolved from *every* path referencing it (below), not just the
    // ones matching --filter, since warmest-wins has to see the whole
    // picture regardless of scope. See
    // docs/architecture/ignore-and-storage-policies.md.
    for (const { hash } of entriesRepo.iterateDistinctHashesMatchingGlob(filter)) {
      const paths = [...entriesRepo.iterateByHash(hash)].map((e) => e.path);
      const { targetClass, conflicted } = resolveHashTargetClass(
        paths,
        nonDefaultPolicies,
        defaultPolicy,
      );
      if (conflicted) conflicts.push({ hash, paths, targetClass });

      const objectRow = objectsRepo.get(hash);
      if (!objectRow) {
        throw new CorruptionError(
          `entries reference object ${hash} but no objects row exists (corrupt state.db?)`,
        );
      }
      const key = remoteKey(location, objectRow.s3_key);
      const head = await headObject(client, remoteConfig.bucket, key);
      if (!head) {
        throw new CorruptionError(`object ${hash} is missing in S3 at "${key}" (corrupt vault?)`);
      }
      const currentClass = head.storageClass ?? "STANDARD";
      if (!isSupportedStorageClass(currentClass)) {
        throw new Error(`object ${hash} has an unsupported storage class "${currentClass}"`);
      }

      const archiveStatus = classifyArchiveStatus(head);
      const action = decideStorageClassAction(currentClass, targetClass, archiveStatus);
      logger.debug(
        { hash, currentClass, targetClass, archiveStatus, action: action.kind },
        "classified object against storage policy",
      );

      switch (action.kind) {
        case "already-correct":
          counts.alreadyCorrect++;
          break;
        case "immediate-copy":
          counts.changedImmediate++;
          break;
        case "needs-restore-request":
          counts.restoreRequested++;
          break;
        case "restore-ongoing":
          counts.restorePending++;
          break;
        case "finalize-copy":
          counts.finalized++;
          break;
      }
    }
  } finally {
    db.close();
  }

  return { counts, conflicts };
}
