import fs from "node:fs";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { tempSiblingPath } from "../fs/temp-path.js";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";
import { openStateDb, openCacheDb } from "../db/connection.js";
import {
  CacheEntriesRepository,
  type CacheEntryRow,
} from "../db/repositories/cache-entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { performUpdateCache, type CaseCollision } from "../fs/update-cache.js";
import { applyLocalChangesToCandidate } from "./apply-local-changes.js";
import { applyRemoteChangesToLocal } from "./apply-remote-changes.js";
import { reconcileCacheAfterCommit } from "./reconcile-cache.js";
import { generateVersionStamp } from "../vault/version-stamp.js";
import { encryptBuffer, decryptBuffer, CryptoAuthError } from "../crypto/chunked-codec.js";
import { getObject, putObject, putObjectCas, CasConflictError } from "../s3/client.js";
import {
  remoteKey,
  stateSnapshotKey,
  CURRENT_POINTER_KEY,
  type RemoteLocation,
} from "../vault/paths.js";
import { localCacheDbPath, localStateDbPath, lastSyncedVersionPath } from "../vault/local-dir.js";
import { CorruptionError } from "../errors.js";
import { renameWithRetry, copyFileWithRetry } from "../fs/safe-fs.js";

export interface SyncConflict {
  path: string;
  reason: string;
}

export interface SyncResult {
  versionStamp: string;
  nothingToSync: boolean;
  uploadedObjects: number;
  dedupedObjects: number;
  localEntriesChanged: number;
  remoteCreated: number;
  remoteModified: number;
  remoteDeleted: number;
  conflicts: SyncConflict[];
  /**
   * Case-insensitive path collisions found while this run's own internal
   * update_cache scan staged its diff -- surfaced here (rather than only
   * logged and silently dropped) since sync's caller has no other way to
   * learn about them. Distinct from `conflicts`: those are state.db commit
   * conflicts on dirty rows; these are local-scan-time and never even
   * become dirty rows in the first place. See
   * docs/architecture/cross-platform-filesystem.md.
   */
  caseCollisions: CaseCollision[];
}

export class RemoteDivergedError extends Error {
  constructor() {
    super(
      "the remote vault has moved on since this machine started this sync attempt -- run sync again",
    );
    this.name = "RemoteDivergedError";
  }
}

/** Yields every row from `rows` unchanged, while also recording its path into `sink` as a side effect. */
function* tapPaths(rows: Iterable<CacheEntryRow>, sink: Set<string>): Generator<CacheEntryRow> {
  for (const row of rows) {
    sink.add(row.path);
    yield row;
  }
}

/** Yields only the rows from `rows` whose path is in `paths`. */
function* filterByPath(
  rows: Iterable<CacheEntryRow>,
  paths: ReadonlySet<string>,
): Generator<CacheEntryRow> {
  for (const row of rows) {
    if (paths.has(row.path)) yield row;
  }
}

/**
 * Full bidirectional sync: runs update_cache, then folds local changes into
 * a candidate state.db (with conflict detection -- src/sync/conflict-
 * rules.ts) while separately applying genuinely remote-only changes
 * straight to the filesystem/cache.db. If there's nothing new to commit
 * (every local change conflicted, or there were no local changes at all),
 * no new version is created or uploaded -- any remote-only changes are
 * still pulled down and the local baseline still advances to match, but
 * that's a plain adoption, not a commit. Conflicting paths are left dirty
 * in cache.db for the user to resolve by hand; everything else that
 * succeeded is still committed in the same run.
 */
export async function performSync(
  root: string,
  masterKey: Buffer,
  s3: { client: S3Client; bucket: string; location: RemoteLocation },
  logger: Logger,
): Promise<SyncResult> {
  const lastSyncedVersion = fs.readFileSync(lastSyncedVersionPath(root), "utf8").trim();
  const cacheDb = openCacheDb(localCacheDbPath(root), logger);
  // Read-only, dedicated to iterating dirty rows: reconciliation below
  // writes to `cacheRepo`'s connection *while* iterating the dirty set, so
  // that iteration has to come from a different connection (the same
  // "iterate() cursor busy" constraint documented in update-cache.ts) --
  // this mirrors apply-remote-changes.ts's cacheReadDb pattern.
  const cacheReadDb = new Database(localCacheDbPath(root), { readonly: true, fileMustExist: true });

  try {
    const cacheRepo = new CacheEntriesRepository(cacheDb);
    const cacheReadRepo = new CacheEntriesRepository(cacheReadDb);
    let updateCacheStats;
    {
      // Read-only, scoped to this call: only used to validate stub-declared
      // hashes against known objects. Local state.db is already decrypted
      // on disk, so this needs no password.
      const stateDbForScan = new Database(localStateDbPath(root), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        updateCacheStats = await performUpdateCache(
          root,
          localCacheDbPath(root),
          cacheRepo,
          new ObjectsRepository(stateDbForScan),
          lastSyncedVersion,
          logger,
        );
      } finally {
        stateDbForScan.close();
      }
    }

    const dirtyCount = cacheRepo.countDirty();

    const currentKey = remoteKey(s3.location, CURRENT_POINTER_KEY);
    const current = await getObject(s3.client, s3.bucket, currentKey);
    if (!current) throw new CorruptionError("vault has no /current pointer (corrupt vault?)");
    const remoteVersionStamp = current.body.toString("utf8");
    const remoteHasMoved = remoteVersionStamp !== lastSyncedVersion;

    // Deliberately NOT an early-exit on "!remoteHasMoved && dirtyCount ===
    // 0": a version-stamp match does NOT mean cache.db already matches
    // state.db's content -- right after a fresh attach_remote, local
    // state.db is fully populated but cache.db is completely empty, so
    // "nothing to sync" always has to be determined from the real
    // cache.db-vs-candidate diff below, never shortcut from version stamps
    // alone.

    logger.debug(
      { dirtyCount, remoteHasMoved, remoteVersionStamp, lastSyncedVersion },
      "sync starting",
    );

    // remoteFreshPath: what's actually current in S3 right now, before this
    // machine's own edits are folded in. Reused as-is (no fetch needed) when
    // remote hasn't moved -- it's already exactly the local state.db.
    let remoteFreshPath = localStateDbPath(root);
    let remoteFreshIsTemp = false;
    if (remoteHasMoved) {
      const snapshot = await getObject(
        s3.client,
        s3.bucket,
        remoteKey(s3.location, stateSnapshotKey(remoteVersionStamp)),
      );
      if (!snapshot) {
        throw new CorruptionError(
          `state.db snapshot for version "${remoteVersionStamp}" is missing`,
        );
      }
      let decrypted: Buffer;
      try {
        decrypted = decryptBuffer(snapshot.body, masterKey);
      } catch (err) {
        if (err instanceof CryptoAuthError) {
          throw new CorruptionError("remote state.db snapshot failed decryption/authentication");
        }
        throw err;
      }
      remoteFreshPath = tempSiblingPath(localStateDbPath(root), "remote-fresh");
      fs.writeFileSync(remoteFreshPath, decrypted);
      remoteFreshIsTemp = true;
    }

    const candidatePath = tempSiblingPath(localStateDbPath(root), "candidate");
    fs.copyFileSync(remoteFreshPath, candidatePath);

    try {
      const versionStamp = generateVersionStamp();
      const candidateDb = openStateDb(candidatePath, logger);
      let localResult, remoteResult, willCommit, cacheBaselineVersion;
      try {
        // excludePaths is filled in as a side effect of the same pass that
        // feeds applyLocalChangesToCandidate, rather than a second read --
        // it needs every dirty path (not just handled ones), which isn't
        // known until this loop actually runs.
        const excludePaths = new Set<string>();
        localResult = await applyLocalChangesToCandidate(
          candidateDb,
          tapPaths(cacheReadRepo.iterateDirty(), excludePaths),
          root,
          masterKey,
          versionStamp,
          s3,
          logger,
        );

        // A version is only worth committing if something *actually*
        // mutated entries/objects -- a sync where every dirty row resolved
        // as a no-op (see conflict-rules.ts) has nothing new to upload.
        willCommit = localResult.appliedCount > 0;
        cacheBaselineVersion = willCommit ? versionStamp : remoteVersionStamp;

        // Diffs cache.db directly against the candidate (remote + this
        // machine's own successful edits) -- see apply-remote-changes.ts
        // for why version-stamp comparison alone isn't the right basis.
        remoteResult = await applyRemoteChangesToLocal(
          candidateDb,
          localCacheDbPath(root),
          root,
          masterKey,
          cacheRepo,
          excludePaths,
          cacheBaselineVersion,
          s3,
          logger,
        );
      } finally {
        candidateDb.close(); // checkpoints WAL before we read the file back
      }

      if (!willCommit) {
        // Nothing new to commit as a version: either every dirty row
        // conflicted or resolved as a no-op, or there were no local changes
        // at all. Any remote-only changes were still pulled down above;
        // just adopt the remote version as the new local baseline if it
        // moved, and still reconcile any no-op-resolved rows to
        // 'unchanged' -- they're resolved even though nothing was uploaded.
        if (remoteHasMoved) {
          await copyFileWithRetry(remoteFreshPath, localStateDbPath(root));
          fs.writeFileSync(lastSyncedVersionPath(root), remoteVersionStamp, "utf8");
        }
        reconcileCacheAfterCommit(
          cacheRepo,
          filterByPath(cacheReadRepo.iterateDirty(), localResult.handledPaths),
          cacheBaselineVersion,
        );

        const remoteTotal = remoteResult.created + remoteResult.modified + remoteResult.deleted;
        const nothingToSync =
          dirtyCount === 0 && remoteTotal === 0 && localResult.conflicts.length === 0;

        return {
          versionStamp: cacheBaselineVersion,
          nothingToSync,
          uploadedObjects: 0,
          dedupedObjects: 0,
          localEntriesChanged: localResult.handledPaths.size,
          remoteCreated: remoteResult.created,
          remoteModified: remoteResult.modified,
          remoteDeleted: remoteResult.deleted,
          conflicts: localResult.conflicts,
          caseCollisions: updateCacheStats.caseCollisions,
        };
      }

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
        if (err instanceof CasConflictError) throw new RemoteDivergedError();
        throw err;
      }

      // Only now, after the CAS succeeded, promote the candidate and
      // reconcile the successfully-applied cache rows -- a crash before
      // this point just leaves ignorable stray temp files and an untouched
      // cache.db, safe to retry.
      await renameWithRetry(candidatePath, localStateDbPath(root));
      fs.writeFileSync(lastSyncedVersionPath(root), versionStamp, "utf8");
      reconcileCacheAfterCommit(
        cacheRepo,
        filterByPath(cacheReadRepo.iterateDirty(), localResult.handledPaths),
        versionStamp,
      );

      return {
        versionStamp,
        nothingToSync: false,
        uploadedObjects: localResult.uploadedObjects,
        dedupedObjects: localResult.dedupedObjects,
        localEntriesChanged: localResult.handledPaths.size,
        remoteCreated: remoteResult.created,
        remoteModified: remoteResult.modified,
        remoteDeleted: remoteResult.deleted,
        conflicts: localResult.conflicts,
        caseCollisions: updateCacheStats.caseCollisions,
      };
    } finally {
      if (fs.existsSync(candidatePath)) fs.rmSync(candidatePath);
      if (remoteFreshIsTemp && fs.existsSync(remoteFreshPath)) fs.rmSync(remoteFreshPath);
    }
  } finally {
    cacheReadDb.close();
    cacheDb.close();
  }
}
