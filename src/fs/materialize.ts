import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
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
 * Materializes every stub matching `glob` back into a real file: downloads
 * the object, decrypts it, verifies its hash, writes it to a tmp path,
 * renames it into place, and only *then* deletes the stub -- so an
 * interrupted materialize always lands in the safe "both exist" state
 * (real file already correct; update_cache cleans up the stray stub on the
 * next scan). Cold objects get a temporary restore requested only when
 * `requestRetrieval` is set; otherwise they're just counted.
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
): Promise<MaterializeStats> {
  const stats: MaterializeStats = {
    materialized: 0,
    alreadyReal: 0,
    needsRetrieval: 0,
    retrievalRequested: 0,
    pending: 0,
  };

  // A single connection/repo covers both the glob scan and cacheRepo.upsert()
  // below: iterateByGlobSortedByPath() is keyset-paginated (src/db/keyset-
  // pagination.ts), not a live `.iterate()` cursor, so the write can safely
  // interleave with it -- a write only ever conflicts with a *paused*
  // cursor, and pagination never leaves one paused between pages.
  {
    for (const row of cacheRepo.iterateByGlobSortedByPath(glob)) {
      if (row.type !== "file") continue;
      const absolutePath = path.join(root, row.path);
      const stubAbsolutePath = stubPathFor(absolutePath);
      const hasReal = fs.existsSync(absolutePath);
      const hasStub = fs.existsSync(stubAbsolutePath);

      if (!hasStub) {
        stats.alreadyReal++;
        continue;
      }
      if (hasReal) {
        // Dangling stub -- the real file already wins. update_cache would
        // normally have cleaned this up already; do it defensively here too.
        fs.rmSync(stubAbsolutePath);
        stats.alreadyReal++;
        continue;
      }

      if (!row.hash) throw new Error(`stub for "${row.path}" has no recorded hash in cache.db`);
      const objectRow = objectsRepo.get(row.hash);
      if (!objectRow) {
        throw new CorruptionError(`stub for "${row.path}" references unknown object ${row.hash}`);
      }

      const key = remoteKey(s3.location, objectRow.s3_key);
      const head = await headObject(s3.client, s3.bucket, key);
      if (!head) {
        throw new CorruptionError(
          `object ${row.hash} for "${row.path}" is missing in S3 (corrupt vault?)`,
        );
      }

      const status = classifyArchiveStatus(head);
      logger.debug({ path: row.path, hash: row.hash, status }, "classified archive status");

      if (status === "immediate" || status === "restore-ready") {
        const encrypted = await getObjectStream(s3.client, s3.bucket, key);
        if (!encrypted) {
          throw new CorruptionError(`object ${row.hash} for "${row.path}" is missing in S3`);
        }

        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        const tmpPath = `${absolutePath}.sync1-tmp-${randomBytes(4).toString("hex")}`;
        let computedHash: string;
        try {
          computedHash = await decryptStreamToFile(encrypted.body, masterKey, tmpPath);
        } catch (err) {
          if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath);
          if (err instanceof CryptoAuthError) {
            throw new CorruptionError(
              `object ${row.hash} for "${row.path}" failed decryption/authentication`,
            );
          }
          throw err;
        }
        if (computedHash !== row.hash) {
          fs.rmSync(tmpPath);
          throw new CorruptionError(
            `object ${row.hash} for "${row.path}" does not match its recorded hash`,
          );
        }

        fs.renameSync(tmpPath, absolutePath); // materialize first...
        fs.rmSync(stubAbsolutePath); // ...only then delete the stub

        cacheRepo.upsert({ ...row, mtime: Math.round(fs.statSync(absolutePath).mtimeMs) });
        stats.materialized++;
        logger.debug({ path: row.path }, "materialized");
      } else if (status === "needs-restore-request" || status === "restore-expired-needs-reissue") {
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
      } else {
        stats.pending++;
      }
    }
  }

  return stats;
}
