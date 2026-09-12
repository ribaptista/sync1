import Database from "better-sqlite3";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";
import { headObject, copyObjectStorageClass, restoreObject } from "../s3/client.js";
import {
  classifyArchiveStatus,
  isSupportedStorageClass,
  type SupportedStorageClass,
} from "../s3/archive-status.js";
import { decideStorageClassAction } from "../s3/storage-class-actions.js";
import { resolveHashTargetClass } from "../s3/policy-evaluation.js";
import { localStateDbPath } from "../vault/local-dir.js";
import { remoteKey, type RemoteLocation } from "../vault/paths.js";
import { EntriesRepository } from "../db/repositories/entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { StoragePoliciesRepository } from "../db/repositories/storage-policies-repository.js";
import { CorruptionError } from "../errors.js";

// Not exposed as flags -- a reasonable default balance of cost/latency for
// the temporary restore window.
const RESTORE_DAYS = 7;
const RESTORE_TIER = "Standard";

export interface ConvergeCounts {
  alreadyCorrect: number;
  changedImmediate: number;
  restoreRequested: number;
  restorePending: number;
  finalized: number;
}

export interface ConvergeConflict {
  hash: string;
  paths: string[];
  targetClass: SupportedStorageClass;
}

export interface ConvergeResult {
  counts: ConvergeCounts;
  conflicts: ConvergeConflict[];
}

/**
 * Shared by `status` (apply=false, a pure count/report) and `converge`
 * (apply=true, actually performs each transition) -- both commands need
 * the exact same iteration/evaluation, differing only in whether a
 * decided action is actually issued to S3. Read-only against state.db
 * either way (HEAD/copy/restore don't decrypt anything, and policies are
 * read from the already-locally-decrypted state.db); no password needed.
 */
export async function convergeStoragePolicies(
  root: string,
  filter: string,
  apply: boolean,
  s3: { client: S3Client; bucket: string; location: RemoteLocation },
  logger: Logger,
): Promise<ConvergeResult> {
  const db = new Database(localStateDbPath(root), { readonly: true, fileMustExist: true });
  const counts: ConvergeCounts = {
    alreadyCorrect: 0,
    changedImmediate: 0,
    restoreRequested: 0,
    restorePending: 0,
    finalized: 0,
  };
  const conflicts: ConvergeConflict[] = [];

  try {
    const entriesRepo = new EntriesRepository(db);
    const objectsRepo = new ObjectsRepository(db);
    const storagePoliciesRepo = new StoragePoliciesRepository(db);
    const nonDefaultPolicies = storagePoliciesRepo.listNonDefaultByPriority();
    const defaultPolicy = storagePoliciesRepo.getDefault();

    // Dedup interaction: iterates distinct *hashes* with at least one
    // matching path, not paths themselves -- a shared object's target is
    // resolved from *every* path referencing it (below), regardless of
    // --filter scope, since warmest-wins has to see the whole picture.
    // See docs/architecture/ignore-and-storage-policies.md.
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
      const key = remoteKey(s3.location, objectRow.s3_key);
      const head = await headObject(s3.client, s3.bucket, key);
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
        { hash, currentClass, targetClass, archiveStatus, action: action.kind, apply },
        "classified object against storage policy",
      );

      switch (action.kind) {
        case "already-correct":
          counts.alreadyCorrect++;
          break;
        case "immediate-copy":
          counts.changedImmediate++;
          if (apply) await copyObjectStorageClass(s3.client, s3.bucket, key, targetClass);
          break;
        case "needs-restore-request":
          counts.restoreRequested++;
          if (apply) {
            await restoreObject(s3.client, s3.bucket, key, {
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
          if (apply) await copyObjectStorageClass(s3.client, s3.bucket, key, targetClass);
          break;
      }
    }
  } finally {
    db.close();
  }

  return { counts, conflicts };
}
