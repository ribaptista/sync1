import type PQueue from "p-queue";
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
import { waitForRoom } from "../concurrency/pools.js";
import { openStateDbReadOnly } from "../db/connection.js";

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
 *
 * The outer loop's own work (resolving every path sharing a hash, warmest-
 * wins conflict detection, the objects-table lookup) is synchronous SQL and
 * stays that way -- it never spans an await, so nothing here needs
 * pagination-style care. Only the tail per hash -- HEAD, classify, and the
 * conditional copy/restore -- is genuine network I/O, and is *dispatched*
 * to `s3Pool` rather than awaited inline: the outer loop advances to the
 * next hash immediately, with up to `s3QueueLimit` such tails in flight at
 * once, joined via `s3Pool.onIdle()` before this returns.
 */
export async function convergeStoragePolicies(
  root: string,
  filter: string,
  apply: boolean,
  s3: { client: S3Client; bucket: string; location: RemoteLocation },
  logger: Logger,
  s3Pool: PQueue,
  s3QueueLimit: number,
  onProgress?: (checked: number) => void,
  /**
   * The number of distinct objects this run will check, reported once
   * before the first `HEAD` goes out. Knowable offline: it's a count over
   * the already-local state.db, and only the *classification* of each
   * object needs S3 -- so the denominator never costs a network round
   * trip, however long the run itself takes.
   */
  onTotalKnown?: (total: number) => void,
): Promise<ConvergeResult> {
  const db = openStateDbReadOnly(localStateDbPath(root));
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
    onTotalKnown?.(entriesRepo.countDistinctHashesMatchingGlob(filter));

    // Counted on completion, not dispatch: dispatch deliberately runs
    // ahead of the pool (that's what the backpressure below bounds), so
    // advancing here would race the bar to 100% while every HEAD was
    // still in flight. That was invisible while the denominator was
    // itself the dispatch count; against a real total it isn't.
    let checked = 0;
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

      await waitForRoom(s3Pool, s3QueueLimit);
      void s3Pool.add(async () => {
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
        logger.debug({ pool: "s3", inFlight: s3Pool.pending, queued: s3Pool.size }, "completed");
        checked++;
        onProgress?.(checked);
      });
      logger.debug({ pool: "s3", inFlight: s3Pool.pending, queued: s3Pool.size }, "dispatched");
    }

    await s3Pool.onIdle();
  } finally {
    db.close();
  }

  return { counts, conflicts };
}
