import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type PQueue from "p-queue";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";
import { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { getObjectStream, headObject, restoreObject } from "../s3/client.js";
import { classifyArchiveStatus } from "../s3/archive-status.js";
import { CryptoAuthError } from "../crypto/chunked-codec.js";
import { remoteKey, type RemoteLocation } from "../vault/paths.js";
import { stubPathFor } from "./stub.js";
import { CorruptionError } from "../errors.js";
import { decryptStreamToFile } from "./decrypt-to-file.js";
import { waitForRoom } from "../concurrency/pools.js";
import { createProgressTracker, type OnProgress } from "../progress-types.js";

export interface MaterializeStats {
  materialized: number;
  alreadyReal: number;
  needsRetrieval: number;
  retrievalRequested: number;
  pending: number;
}

// Not exposed as flags -- matches status/converge's restore defaults.
const RESTORE_DAYS = 7;
const RESTORE_TIER = "Standard";

/**
 * Counts the work `materializeGlob` is about to do without doing any of
 * it: the same glob scan and the same real/stub checks, and not one S3
 * call. Everything it consults is either already-local (cache.db, and
 * state.db's `objects` table for sizes) or a plain `existsSync`, which is
 * the point -- a counting pass that had to issue HEADs would be throttled
 * by the very pool whose queue depth it exists to explain, and would
 * finish telling you the total at roughly the moment the run ended.
 *
 * `bytes` is the size of every stub this run is *responsible for*, not of
 * the subset that will turn out to be immediately downloadable: whether
 * an object is archived is knowable only from a HEAD. An archived object
 * resolves by having its retrieval requested and counts toward the total
 * the same way a downloaded one does -- see `skipBytes` below.
 *
 * Never throws on a missing/corrupt object row the way the real pass
 * does: this is advisory, and a bad denominator must not be the thing
 * that fails a run.
 */
function enumerateMaterializeWork(
  root: string,
  glob: string,
  cacheRepo: CacheEntriesRepository,
  objectsRepo: ObjectsRepository,
): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const row of cacheRepo.iterateByGlobSortedByPath(glob)) {
    // Counts every glob-matched row, mirroring rowDiscovered() below --
    // including directories and already-real files, which resolve
    // immediately but are still "how far through the scan" progress.
    files++;
    if (row.type !== "file" || !row.hash) continue;
    const absolutePath = path.join(root, row.path);
    if (!fs.existsSync(stubPathFor(absolutePath))) continue; // already real
    if (fs.existsSync(absolutePath)) continue; // dangling stub, real file wins
    bytes += objectsRepo.get(row.hash)?.size ?? 0;
  }
  return { files, bytes };
}

/**
 * Materializes every stub matching `glob` back into a real file: downloads
 * the object, decrypts it, verifies its hash, writes it to a tmp path,
 * renames it into place, and only *then* deletes the stub -- so an
 * interrupted materialize always lands in the safe "both exist" state
 * (real file already correct; update_cache cleans up the stray stub on the
 * next scan). Cold objects get a temporary restore requested only when
 * `requestRetrieval` is set; otherwise they're just counted.
 *
 * Each stub's HEAD check is *dispatched* to `s3Pool` rather than awaited
 * inline -- the glob scan advances to the next row immediately. A HEAD's
 * own completion classifies the archive status and either dispatches the
 * download+decrypt+verify+rename to `streamPool` (immediate/restore-ready)
 * or issues the (cheap) restore request inline, still within that same
 * `s3Pool` slot (restoreObject is itself a bare S3 call, not worth its own
 * dispatch layer). `s3Pool.onIdle()` is drained before `streamPool.onIdle()`
 * -- by the time every HEAD job has settled, every download it might have
 * triggered has already been enqueued into `streamPool`.
 */
export async function materializeGlob(
  root: string,
  glob: string,
  cacheRepo: CacheEntriesRepository,
  objectsRepo: ObjectsRepository,
  masterKey: Buffer,
  requestRetrieval: boolean,
  s3: { client: S3Client; bucket: string; location: RemoteLocation },
  logger: Logger,
  s3Pool: PQueue,
  s3QueueLimit: number,
  streamPool: PQueue,
  streamQueueLimit: number,
  onProgress?: OnProgress,
): Promise<MaterializeStats> {
  const stats: MaterializeStats = {
    materialized: 0,
    alreadyReal: 0,
    needsRetrieval: 0,
    retrievalRequested: 0,
    pending: 0,
  };

  // filesDone/filesTotal track every glob-matched row (regardless of
  // whether it actually needed a download); bytesDone/bytesTotal track
  // every stub this run is responsible for resolving -- including one
  // whose object turns out to be archived, which resolves by having its
  // retrieval requested rather than by transferring anything. Counting
  // only the downloadable subset would make the byte total unknowable
  // until every HEAD had come back, which is the whole run.
  // rowDiscovered() fires once per glob-matched row, at the top of the
  // loop below; rowResolved() fires immediately for a synchronous outcome
  // (not a stub, a dangling stub, a cold object) and is deferred into the
  // download's own completion for a stub that is immediately retrievable.
  const progress = createProgressTracker(onProgress, ["downloading", "downloaded"]);

  // Offline, and therefore available before the first HEAD goes out --
  // the denominator is correct from the start of the run rather than
  // converging on correct as it ends. Left provisional (no `final`)
  // because the filesystem can still shift underneath it; settle() in the
  // `finally` below replaces it with what the run actually observed.
  const enumerated = enumerateMaterializeWork(root, glob, cacheRepo, objectsRepo);
  progress.setEstimatedTotals({ files: enumerated.files, bytes: enumerated.bytes });

  // A single connection/repo covers both the glob scan and cacheRepo.upsert()
  // below: iterateByGlobSortedByPath() is keyset-paginated (src/db/keyset-
  // pagination.ts), not a live `.iterate()` cursor, so the write can safely
  // interleave with it -- a write only ever conflicts with a *paused*
  // cursor, and pagination never leaves one paused between pages.
  try {
    for (const row of cacheRepo.iterateByGlobSortedByPath(glob)) {
      progress.rowDiscovered();
      if (row.type !== "file") {
        progress.rowResolved();
        continue;
      }
      const absolutePath = path.join(root, row.path);
      const stubAbsolutePath = stubPathFor(absolutePath);
      const hasReal = fs.existsSync(absolutePath);
      const hasStub = fs.existsSync(stubAbsolutePath);

      if (!hasStub) {
        stats.alreadyReal++;
        progress.rowResolved();
        continue;
      }
      if (hasReal) {
        // Dangling stub -- the real file already wins. update_cache would
        // normally have cleaned this up already; do it defensively here too.
        fs.rmSync(stubAbsolutePath);
        stats.alreadyReal++;
        progress.rowResolved();
        continue;
      }

      if (!row.hash) throw new Error(`stub for "${row.path}" has no recorded hash in cache.db`);
      const hash = row.hash;
      const objectRow = objectsRepo.get(hash);
      if (!objectRow) {
        throw new CorruptionError(`stub for "${row.path}" references unknown object ${hash}`);
      }
      const key = remoteKey(s3.location, objectRow.s3_key);

      // Counted here, at classification time, not inside the HEAD job: this
      // stub is already known to be this run's responsibility, and the size
      // is already in hand. Deferring it until the HEAD came back would
      // make the observed byte total grow at S3's pace, which is exactly
      // what the enumeration pass above exists to avoid.
      progress.expectBytes(objectRow.size);

      await waitForRoom(s3Pool, s3QueueLimit);
      void s3Pool.add(async () => {
        const head = await headObject(s3.client, s3.bucket, key);
        if (!head) {
          throw new CorruptionError(
            `object ${hash} for "${row.path}" is missing in S3 (corrupt vault?)`,
          );
        }

        const status = classifyArchiveStatus(head);
        logger.debug({ path: row.path, hash, status }, "classified archive status");

        if (status === "immediate" || status === "restore-ready") {
          await waitForRoom(streamPool, streamQueueLimit);
          void streamPool.add(async () => {
            const fileTracker = progress.startFile(row.path, objectRow.size);
            try {
              const encrypted = await getObjectStream(s3.client, s3.bucket, key);
              if (!encrypted) {
                throw new CorruptionError(`object ${hash} for "${row.path}" is missing in S3`);
              }

              fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
              const tmpPath = `${absolutePath}.sync1-tmp-${randomBytes(4).toString("hex")}`;
              let computedHash: string;
              try {
                computedHash = await decryptStreamToFile(encrypted.body, masterKey, tmpPath, (n) =>
                  fileTracker.advance(n),
                );
              } catch (err) {
                if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath);
                if (err instanceof CryptoAuthError) {
                  throw new CorruptionError(
                    `object ${hash} for "${row.path}" failed decryption/authentication`,
                  );
                }
                throw err;
              }
              if (computedHash !== hash) {
                fs.rmSync(tmpPath);
                throw new CorruptionError(
                  `object ${hash} for "${row.path}" does not match its recorded hash`,
                );
              }

              fs.renameSync(tmpPath, absolutePath); // materialize first...
              fs.rmSync(stubAbsolutePath); // ...only then delete the stub

              cacheRepo.upsert({ ...row, mtime: Math.round(fs.statSync(absolutePath).mtimeMs) });
              stats.materialized++;
              logger.debug({ path: row.path }, "materialized");
              logger.debug(
                { pool: "stream", inFlight: streamPool.pending, queued: streamPool.size },
                "completed",
              );
            } finally {
              // Unconditional, per FileTracker's own contract -- see
              // update-cache.ts's dispatchHash for why this matters even on
              // the error paths above. rowResolved() lives here too: this is
              // the one branch of the three below that has any further byte
              // work pending after the HEAD check settles.
              fileTracker.finish();
              progress.rowResolved();
            }
          });
          logger.debug(
            { pool: "stream", inFlight: streamPool.pending, queued: streamPool.size },
            "dispatched",
          );
        } else if (
          status === "needs-restore-request" ||
          status === "restore-expired-needs-reissue"
        ) {
          if (requestRetrieval) {
            await restoreObject(s3.client, s3.bucket, key, {
              days: RESTORE_DAYS,
              tier: RESTORE_TIER,
            });
            stats.retrievalRequested++;
            logger.debug({ path: row.path }, "requested temporary retrieval");
          } else {
            stats.needsRetrieval++;
          }
          // No download this run either way -- nothing further pending. The
          // bytes were counted toward the total when this stub was
          // classified, so they resolve here rather than being transferred;
          // leaving them outstanding would park the bar short of 100% for
          // every archived object in the run.
          progress.skipBytes(objectRow.size);
          progress.rowResolved();
        } else {
          stats.pending++;
          progress.skipBytes(objectRow.size);
          progress.rowResolved();
        }

        logger.debug({ pool: "s3", inFlight: s3Pool.pending, queued: s3Pool.size }, "completed");
      });
      logger.debug({ pool: "s3", inFlight: s3Pool.pending, queued: s3Pool.size }, "dispatched");
    }

    await s3Pool.onIdle();
    await streamPool.onIdle();
  } finally {
    // Whatever the run actually observed is the truth now, however the
    // enumeration above guessed -- including on the error paths, where a
    // half-finished run should stop claiming a total it will never reach.
    progress.settle();
  }

  return stats;
}
