import fs from "node:fs";
import { randomBytes } from "node:crypto";
import type PQueue from "p-queue";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";
import { openStateDb } from "../db/connection.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { VersionsRepository } from "../db/repositories/versions-repository.js";
import { generateVersionStamp } from "../vault/version-stamp.js";
import { encryptBuffer, decryptBuffer, CryptoAuthError } from "../crypto/chunked-codec.js";
import {
  getObject,
  putObject,
  putObjectCas,
  deleteObject,
  CasConflictError,
} from "../s3/client.js";
import {
  remoteKey,
  stateSnapshotKey,
  CURRENT_POINTER_KEY,
  type RemoteLocation,
} from "../vault/paths.js";
import { localStateDbPath, lastSyncedVersionPath } from "../vault/local-dir.js";
import { CorruptionError } from "../errors.js";
import { tempSiblingPath } from "../fs/temp-path.js";
import { copyFileWithRetry } from "../fs/safe-fs.js";
import {
  waitForRoom,
  createPoolErrorBox,
  dispatchTracked,
  throwIfPoolErrored,
} from "../concurrency/pools.js";

export interface GcResult {
  orphanCount: number;
  reclaimedBytes: number;
  applied: boolean;
}

const MAX_CAS_ATTEMPTS = 5;

/**
 * Removes objects no longer referenced by any *current* entry -- scoped to
 * the live state only (see docs/architecture/garbage-collection-scope.md
 * for why old /states/<version> snapshots are deliberately allowed to lose
 * content-recoverability for reclaimed objects; this is what actually
 * reclaims storage, since keeping every version forever would otherwise
 * pin every hash ever referenced).
 *
 * Always re-fetches /current fresh (never trusts local state.db, which may
 * be stale) and, on a CAS conflict against /current, refetches and
 * recomputes from scratch rather than failing outright -- unlike `sync`,
 * removing orphans is a pure recomputation with no human conflict to
 * resolve, so retrying automatically is safe.
 *
 * `onBeforeCas` is a test-only seam: called immediately before each CAS
 * attempt, giving a test a deterministic point to inject a competing
 * commit and force a real retry, rather than relying on real-world timing
 * between two separate processes.
 */
export async function performGc(
  root: string,
  masterKey: Buffer,
  s3: { client: S3Client; bucket: string; location: RemoteLocation },
  apply: boolean,
  logger: Logger,
  s3Pool: PQueue,
  s3QueueLimit: number,
  onBeforeCas?: () => Promise<void>,
  onProgress?: (deleted: number) => void,
  /**
   * The orphan count, reported once, before the first delete is dispatched
   * -- gc is the one command that has always known its exact total up
   * front (`countStagedOrphans` below runs before the loop) and simply
   * never told anyone, leaving its bar to infer a denominator from its own
   * running dispatch count.
   */
  onTotalKnown?: (total: number) => void,
): Promise<GcResult> {
  const currentKey = remoteKey(s3.location, CURRENT_POINTER_KEY);

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const current = await getObject(s3.client, s3.bucket, currentKey);
    if (!current) throw new CorruptionError("vault has no /current pointer (corrupt vault?)");
    const versionStamp = current.body.toString("utf8");

    const snapshot = await getObject(
      s3.client,
      s3.bucket,
      remoteKey(s3.location, stateSnapshotKey(versionStamp)),
    );
    if (!snapshot)
      throw new CorruptionError(`state.db snapshot for version "${versionStamp}" is missing`);

    let decrypted: Buffer;
    try {
      decrypted = decryptBuffer(snapshot.body, masterKey);
    } catch (err) {
      if (err instanceof CryptoAuthError) {
        throw new CorruptionError("state.db snapshot failed decryption/authentication");
      }
      throw err;
    }

    const candidatePath = tempSiblingPath(localStateDbPath(root), "gc-candidate");
    fs.writeFileSync(candidatePath, decrypted);

    try {
      const candidateDb = openStateDb(candidatePath, logger);
      try {
        const objectsRepo = new ObjectsRepository(candidateDb);

        if (!apply) {
          const { count, totalSize } = objectsRepo.countOrphaned();
          return { orphanCount: count, reclaimedBytes: totalSize, applied: false };
        }

        // Stages (hash, s3_key, size) for every currently-orphaned object
        // into a connection-scoped temp table -- this is what lets the
        // local `objects` rows be removed now (before upload) while still
        // knowing which S3 objects to delete later (only after the CAS
        // commit succeeds), without ever holding the orphan set as a JS
        // array.
        objectsRepo.stageOrphansForDeletion();
        const { count: orphanCount, totalSize: reclaimedBytes } = objectsRepo.countStagedOrphans();

        if (orphanCount === 0) {
          return { orphanCount: 0, reclaimedBytes: 0, applied: false };
        }

        objectsRepo.deleteStagedOrphans();
        const newVersionStamp = generateVersionStamp();
        new VersionsRepository(candidateDb).insert(newVersionStamp, new Date().toISOString());
        logger.debug(
          { orphanCount, versionStamp: newVersionStamp },
          "gc: removing orphan object references",
        );

        // Checkpoint (rather than close) so the on-disk file reflects every
        // write before we read it back for upload -- the connection stays
        // open because `gc_pending_deletes` (populated above) is a
        // connection-scoped temp table, needed again below once the CAS
        // commit succeeds.
        candidateDb.pragma("wal_checkpoint(TRUNCATE)");

        const candidateBytes = fs.readFileSync(candidatePath);
        const context = randomBytes(16); // non-convergent: state.db isn't content-addressed
        const encrypted = encryptBuffer(candidateBytes, masterKey, context);
        await putObject(
          s3.client,
          s3.bucket,
          remoteKey(s3.location, stateSnapshotKey(newVersionStamp)),
          encrypted,
        );

        await onBeforeCas?.();

        try {
          await putObjectCas(
            s3.client,
            s3.bucket,
            currentKey,
            Buffer.from(newVersionStamp, "utf8"),
            {
              ifMatch: current.etag,
            },
          );
        } catch (err) {
          if (err instanceof CasConflictError) {
            logger.debug({ attempt }, "gc: CAS conflict, refetching and recomputing");
            continue; // another commit landed first -- recompute from the new /current
          }
          throw err;
        }

        // Only now, after the CAS succeeded, is it safe to delete the
        // actual object bytes -- any future commit referencing one of
        // these hashes again would have to build on this version (or
        // later), which no longer lists them, so it would simply re-upload.
        // The paginated producer (iterateStagedOrphans) dispatches each
        // delete to s3Pool with backpressure rather than awaiting inline --
        // an unbounded producer feeding a pool is just as unbounded as
        // materializing the whole orphan set into an array up front.
        onTotalKnown?.(orphanCount);
        // Counted on *completion*, not dispatch -- which is what this
        // callback's own parameter name always claimed. Dispatch runs
        // ahead of the pool by design (that's what the backpressure above
        // bounds), so advancing there would race the bar to 100% while
        // deletes were still in flight. Harmless while the denominator was
        // itself derived from the dispatch count; wrong the moment the
        // denominator became the real total.
        let deleted = 0;
        // Created fresh per CAS attempt (not hoisted above the loop) --
        // each attempt is its own independent delete sweep, so a box from
        // an earlier, since-abandoned attempt must never leak into this
        // one. See dispatchTracked's own doc comment (src/concurrency/
        // pools.ts): s3Pool.onIdle() alone can't tell this function a
        // dispatched delete threw, since a rejection just discarded by
        // `void s3Pool.add(...)` becomes an unhandled one.
        const s3PoolErrors = createPoolErrorBox();
        for (const o of objectsRepo.iterateStagedOrphans()) {
          await waitForRoom(s3Pool, s3QueueLimit);
          dispatchTracked(s3Pool, s3PoolErrors, async () => {
            await deleteObject(s3.client, s3.bucket, remoteKey(s3.location, o.s3_key));
            logger.debug(
              { pool: "s3", inFlight: s3Pool.pending, queued: s3Pool.size },
              "completed",
            );
            deleted++;
            onProgress?.(deleted);
          });
          logger.debug({ pool: "s3", inFlight: s3Pool.pending, queued: s3Pool.size }, "dispatched");
        }
        await s3Pool.onIdle();
        // The CAS commit above already succeeded by this point -- the new
        // version's `objects` table no longer lists these hashes at all,
        // committed or not, per the two-phase design this function's own
        // doc comment describes ("only now, after the CAS succeeded, is it
        // safe to delete the actual object bytes"). A delete failure here
        // was already a pre-existing leak risk before this box existed
        // (an interrupted process at this exact point has the same
        // effect); throwing here doesn't change that, but it does turn
        // what used to be an unhandled-rejection crash into a clean,
        // reported error -- and correctly skips promoting *this* process's
        // own local state.db copy / last_synced_version to the new
        // version, so at least this machine doesn't silently believe the
        // sweep fully completed when it didn't.
        throwIfPoolErrored(s3PoolErrors);

        await copyFileWithRetry(candidatePath, localStateDbPath(root));
        fs.writeFileSync(lastSyncedVersionPath(root), newVersionStamp, "utf8");

        return {
          orphanCount,
          reclaimedBytes,
          applied: true,
        };
      } finally {
        if (candidateDb.open) candidateDb.close();
      }
    } finally {
      if (fs.existsSync(candidatePath)) fs.rmSync(candidatePath);
    }
  }

  throw new Error(`gc: too many concurrent commits (${MAX_CAS_ATTEMPTS} attempts) -- try again`);
}
