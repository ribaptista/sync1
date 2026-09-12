import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Command, OptionValues } from "commander";
import { createLogger, type Logger } from "../logger.js";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { createS3Client, headObject, copyObjectStorageClass, restoreObject } from "../s3/client.js";
import { classifyArchiveStatus, isSupportedStorageClass } from "../s3/archive-status.js";
import { decideStorageClassAction } from "../s3/storage-class-actions.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import { sync1Dir, localStateDbPath, localRemoteConfigPath } from "../vault/local-dir.js";
import { remoteKey, normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import { EntriesRepository } from "../db/repositories/entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { CorruptionError } from "../errors.js";

// Not exposed as flags (matches the plan's scope) -- a reasonable default
// balance of cost/latency for the temporary restore window.
const RESTORE_DAYS = 7;
const RESTORE_TIER = "Standard";

interface EnsureStorageClassOptions extends OptionValues {
  root: string;
  apply?: boolean;
}

interface GlobalOptions extends OptionValues {
  json?: boolean;
  verbose?: boolean;
}

export interface EnsureStorageClassCounts {
  alreadyCorrect: number;
  changedImmediate: number;
  restoreRequested: number;
  restorePending: number;
  finalized: number;
}

export function registerEnsureStorageClassCommand(program: Command): void {
  program
    .command("ensure_storage_class")
    .description("Move objects matching a glob pattern to a target S3 storage class")
    .argument("<glob>", "SQLite GLOB pattern matched against tracked paths")
    .argument("<class>", "target storage class: STANDARD, GLACIER, or DEEP_ARCHIVE")
    .requiredOption("--root <path>", "local directory whose vault to operate on")
    .option("--apply", "actually perform the changes (default: count only)")
    .action(
      async (
        glob: string,
        targetClassRaw: string,
        opts: EnsureStorageClassOptions,
        command: Command,
      ) => {
        const globalOpts = command.optsWithGlobals<GlobalOptions>();
        const json = globalOpts.json ?? false;
        const logger = createLogger(globalOpts.verbose ?? false).child({
          command: "ensure_storage_class",
        });

        try {
          const counts = await runEnsureStorageClass(glob, targetClassRaw, opts, logger);
          if (json) {
            emitJson({
              ok: true,
              applied: opts.apply ?? false,
              already_correct: counts.alreadyCorrect,
              changed_immediate: counts.changedImmediate,
              restore_requested: counts.restoreRequested,
              restore_pending: counts.restorePending,
              finalized: counts.finalized,
            });
          } else {
            const mode = opts.apply ? "applied" : "counted (pass --apply to perform)";
            process.stdout.write(
              `ensure_storage_class (${mode}): ${counts.alreadyCorrect} already correct, ${counts.changedImmediate} changed immediately, ${counts.restoreRequested} restore requested, ${counts.restorePending} restore pending, ${counts.finalized} finalized\n`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.debug({ err: message }, "ensure_storage_class failed");
          emitError(json, message, exitCodeForError(err));
        }
      },
    );
}

async function runEnsureStorageClass(
  glob: string,
  targetClassRaw: string,
  opts: EnsureStorageClassOptions,
  logger: Logger,
): Promise<EnsureStorageClassCounts> {
  if (!isSupportedStorageClass(targetClassRaw)) {
    throw new Error(
      `unsupported storage class "${targetClassRaw}" — expected STANDARD, GLACIER, or DEEP_ARCHIVE`,
    );
  }
  const targetClass = targetClassRaw;

  const root = path.resolve(opts.root);
  const sync1DirPath = sync1Dir(root);
  if (!fs.existsSync(sync1DirPath)) {
    throw new Error(`"${sync1DirPath}" does not exist — run init_remote or attach_remote first`);
  }

  const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
  const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
  const prefix = normalizePrefix(remoteConfig.prefix);
  const location: RemoteLocation = { bucket: remoteConfig.bucket, prefix };

  const db = new Database(localStateDbPath(root), { readonly: true, fileMustExist: true });
  const counts: EnsureStorageClassCounts = {
    alreadyCorrect: 0,
    changedImmediate: 0,
    restoreRequested: 0,
    restorePending: 0,
    finalized: 0,
  };

  try {
    const entriesRepo = new EntriesRepository(db);
    const objectsRepo = new ObjectsRepository(db);

    // Dedup interaction: this iterates distinct *hashes* matching the glob,
    // not paths -- a storage-class change applies to the underlying object,
    // which may be referenced by paths outside the glob too (see
    // docs/architecture/storage-classes-and-archive-restore.md).
    for (const { hash } of entriesRepo.iterateDistinctHashesMatchingGlob(glob)) {
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
        "classified object",
      );

      switch (action.kind) {
        case "already-correct":
          counts.alreadyCorrect++;
          break;
        case "immediate-copy":
          counts.changedImmediate++;
          if (opts.apply)
            await copyObjectStorageClass(client, remoteConfig.bucket, key, targetClass);
          break;
        case "needs-restore-request":
          counts.restoreRequested++;
          if (opts.apply) {
            await restoreObject(client, remoteConfig.bucket, key, {
              days: RESTORE_DAYS,
              tier: RESTORE_TIER,
            });
          }
          break;
        case "restore-ongoing":
          counts.restorePending++;
          break;
        case "finalize-copy":
          counts.finalized++;
          if (opts.apply)
            await copyObjectStorageClass(client, remoteConfig.bucket, key, targetClass);
          break;
      }
    }
  } finally {
    db.close();
  }

  return counts;
}
