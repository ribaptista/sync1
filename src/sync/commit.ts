import fs from "node:fs";
import { randomBytes } from "node:crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";
import { openStateDb, openCacheDb } from "../db/connection.js";
import { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import { performUpdateCache } from "../fs/update-cache.js";
import { applyLocalChangesToCandidate } from "./apply-local-changes.js";
import { reconcileCacheAfterCommit } from "./reconcile-cache.js";
import { generateVersionStamp } from "../vault/version-stamp.js";
import { encryptBuffer } from "../crypto/chunked-codec.js";
import { getObject, putObject, putObjectCas, CasConflictError } from "../s3/client.js";
import {
  remoteKey,
  stateSnapshotKey,
  CURRENT_POINTER_KEY,
  type RemoteLocation,
} from "../vault/paths.js";
import { localCacheDbPath, localStateDbPath, lastSyncedVersionPath } from "../vault/local-dir.js";

export interface SyncResult {
  versionStamp: string;
  nothingToSync: boolean;
  uploadedObjects: number;
  dedupedObjects: number;
  entriesChanged: number;
}

export class RemoteDivergedError extends Error {
  constructor() {
    super(
      "the remote vault has moved on since this machine last synced -- run fetch_remote and sync again",
    );
    this.name = "RemoteDivergedError";
  }
}

/**
 * Local-to-remote sync (Task 7 scope: single machine, no conflicts -- the
 * full bidirectional merge/conflict algebra is Task 8). Runs update_cache
 * first, then folds every dirty cache row into a *candidate copy* of
 * state.db (never the live local file directly, so a failed attempt is
 * always a clean no-op), uploads it, and only promotes the candidate to be
 * the real local state.db after the CAS-guarded /current write actually
 * succeeds.
 */
export async function performSync(
  root: string,
  masterKey: Buffer,
  s3: { client: S3Client; bucket: string; location: RemoteLocation },
  logger: Logger,
): Promise<SyncResult> {
  const lastSyncedVersion = fs.readFileSync(lastSyncedVersionPath(root), "utf8").trim();
  const cacheDb = openCacheDb(localCacheDbPath(root), logger);

  try {
    const cacheRepo = new CacheEntriesRepository(cacheDb);
    await performUpdateCache(root, cacheRepo, lastSyncedVersion, logger);

    // Snapshot dirty rows into an array up front: better-sqlite3 disallows
    // other statements on the same connection while a .iterate() cursor is
    // open, and reconcileCacheAfterCommit needs to write later anyway.
    const dirtyRows = [...cacheRepo.iterateDirty()];

    if (dirtyRows.length === 0) {
      return {
        versionStamp: lastSyncedVersion,
        nothingToSync: true,
        uploadedObjects: 0,
        dedupedObjects: 0,
        entriesChanged: 0,
      };
    }

    logger.debug({ count: dirtyRows.length }, "dirty rows to fold into this sync");

    const currentKey = remoteKey(s3.location, CURRENT_POINTER_KEY);
    const current = await getObject(s3.client, s3.bucket, currentKey);
    if (!current) {
      throw new Error(`vault has no /current pointer (corrupt vault?)`);
    }
    const remoteVersionStamp = current.body.toString("utf8");
    if (remoteVersionStamp !== lastSyncedVersion) {
      // Task 7 doesn't implement the merge/conflict algebra yet -- refuse to
      // guess rather than silently clobber a remote change this machine
      // hasn't seen. Task 8 replaces this with the real bidirectional merge.
      throw new RemoteDivergedError();
    }

    const versionStamp = generateVersionStamp();
    logger.debug({ versionStamp }, "generated candidate version stamp");

    const candidatePath = `${localStateDbPath(root)}.candidate-${randomBytes(4).toString("hex")}`;
    fs.copyFileSync(localStateDbPath(root), candidatePath);

    try {
      const candidateDb = openStateDb(candidatePath, logger);
      const applyResult = await applyLocalChangesToCandidate(
        candidateDb,
        dirtyRows,
        root,
        masterKey,
        versionStamp,
        s3,
        logger,
      );
      candidateDb.close(); // checkpoints WAL before we read the file back

      const candidateBytes = fs.readFileSync(candidatePath);
      const stateContext = randomBytes(16); // non-convergent: state.db isn't content-addressed
      const encryptedStateDb = encryptBuffer(candidateBytes, masterKey, stateContext);

      logger.debug({ versionStamp }, "uploading candidate state.db snapshot");
      await putObject(
        s3.client,
        s3.bucket,
        remoteKey(s3.location, stateSnapshotKey(versionStamp)),
        encryptedStateDb,
      );

      logger.debug({ versionStamp, ifMatch: current.etag }, "attempting CAS commit of /current");
      try {
        await putObjectCas(s3.client, s3.bucket, currentKey, Buffer.from(versionStamp, "utf8"), {
          ifMatch: current.etag,
        });
      } catch (err) {
        if (err instanceof CasConflictError) {
          throw new RemoteDivergedError();
        }
        throw err;
      }

      // Only now, after the CAS succeeded, promote the candidate and
      // reconcile cache.db -- a crash before this point just leaves an
      // ignorable stray candidate file and an untouched cache.db, safe to
      // retry.
      fs.renameSync(candidatePath, localStateDbPath(root));
      fs.writeFileSync(lastSyncedVersionPath(root), versionStamp, "utf8");
      reconcileCacheAfterCommit(cacheRepo, dirtyRows, versionStamp);

      return {
        versionStamp,
        nothingToSync: false,
        uploadedObjects: applyResult.uploadedObjects,
        dedupedObjects: applyResult.dedupedObjects,
        entriesChanged: applyResult.entriesChanged,
      };
    } finally {
      if (fs.existsSync(candidatePath)) fs.rmSync(candidatePath);
    }
  } finally {
    cacheDb.close();
  }
}
