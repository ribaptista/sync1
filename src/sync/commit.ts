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
import { IgnorePoliciesRepository } from "../db/repositories/ignore-policies-repository.js";
import { performUpdateCache, type CaseCollision } from "../fs/update-cache.js";
import type { ConcurrencyPools } from "../concurrency/pools.js";
import { applyLocalChangesToCandidate, type HandledPathStamps } from "./apply-local-changes.js";
import { applyRemoteChangesToLocal, type IgnoredButSyncedEntry } from "./apply-remote-changes.js";
import { reconcileCacheAfterCommit } from "./reconcile-cache.js";
import { generateVersionStamp } from "../vault/version-stamp.js";
import { encryptBuffer, decryptBuffer, CryptoAuthError } from "../crypto/chunked-codec.js";
import { getObject, putObject, putObjectCas, CasConflictError } from "../s3/client.js";
import { withS3Retry, type RetryNotice } from "../s3/retry.js";
import {
  remoteKey,
  stateSnapshotKey,
  CURRENT_POINTER_KEY,
  type RemoteLocation,
} from "../vault/paths.js";
import { localCacheDbPath, localStateDbPath, lastSyncedVersionPath } from "../vault/local-dir.js";
import { CorruptionError } from "../errors.js";
import { renameWithRetry, copyFileWithRetry } from "../fs/safe-fs.js";
import type { OnProgress } from "../progress-types.js";

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
  /**
   * Remote content materialized/stub-updated despite matching a global
   * ignore policy -- always pre-existing shared content (committed before
   * the policy existed, or before this machine had synced it). Purely
   * informational: never affects sync's exit code, since nothing failed to
   * apply here.
   */
  ignoredButSynced: IgnoredButSyncedEntry[];
}

export class RemoteDivergedError extends Error {
  constructor() {
    super(
      "the remote vault has moved on since this machine started this sync attempt -- run sync again",
    );
    this.name = "RemoteDivergedError";
  }
}

/**
 * `onRetry` for the S3 calls that bracket a run rather than move a file's
 * bytes. Unlike the transfer paths, these have no `FileTracker` and no bar
 * of their own to write into, so the log is the only place a retry can
 * surface -- and `createLoggerForRun` sends it to fd 3, clear of the bars.
 */
function retryLogger(logger: Logger, what: string): (notice: RetryNotice) => void {
  return (notice) => {
    logger.warn(
      {
        attempt: notice.attempt,
        delayMs: notice.delayMs,
        err: notice.error instanceof Error ? notice.error.message : String(notice.error),
      },
      `transient S3 failure ${what} -- retrying`,
    );
  };
}

/** Yields every row from `rows` unchanged, while also recording its path into `sink` as a side effect. */
function* tapPaths(rows: Iterable<CacheEntryRow>, sink: Set<string>): Generator<CacheEntryRow> {
  for (const row of rows) {
    sink.add(row.path);
    yield row;
  }
}

/**
 * Counts the upload phase's work offline, before a single byte moves:
 * every dirty row is one file to resolve, and a row's bytes count only if
 * its content isn't already an object the candidate knows (a dedup attach)
 * and isn't already claimed by an earlier row in the same batch (a
 * same-batch dedup, which rides along on that row's upload).
 *
 * Deliberately does *not* consult the candidate's `entries` table to
 * predict conflicts or no-ops. That would mean re-deriving
 * decideLocalChange's whole ruleset here, and getting it subtly wrong is
 * worse than over-counting: a conflicting row's bytes are simply never
 * uploaded, and `settle()` at the end of the phase brings the bar back
 * down to what really happened.
 */
function enumerateUploadWork(
  dirtyRows: Iterable<CacheEntryRow>,
  objectsRepo: ObjectsRepository,
): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const claimedHashes = new Set<string>();
  for (const row of dirtyRows) {
    files++;
    // Deletes, directories, and rows with no content hash resolve without
    // transferring anything -- counted as files, worth zero bytes.
    if (row.state === "deleted" || row.type !== "file" || row.hash === null) continue;
    if (objectsRepo.has(row.hash) || claimedHashes.has(row.hash)) continue;
    claimedHashes.add(row.hash);
    bytes += row.size ?? 0;
  }
  return { files, bytes };
}

/** Yields only the rows from `rows` whose path was handled by this run. */
function* filterByPath(
  rows: Iterable<CacheEntryRow>,
  handled: HandledPathStamps,
): Generator<CacheEntryRow> {
  for (const row of rows) {
    if (handled.has(row.path)) yield row;
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
  pools: ConcurrencyPools,
  /**
   * Asked for one progress sink per phase, as each phase begins -- not a
   * single sink for the whole run. See the note below on why sync's three
   * phases get three bars rather than one stitched total.
   */
  onPhase?: (label: string) => OnProgress | undefined,
): Promise<SyncResult> {
  const lastSyncedVersion = fs.readFileSync(lastSyncedVersionPath(root), "utf8").trim();
  const cacheDb = openCacheDb(localCacheDbPath(root), logger);

  // performSync runs three phases fully sequentially (performUpdateCache,
  // then applyLocalChangesToCandidate, then applyRemoteChangesToLocal),
  // each reporting its own progress from zero. They used to be welded into
  // a single bar by a `base` offset accumulated across phase boundaries;
  // they now get one bar each, because a combined denominator was never a
  // real quantity: phase 2 works on the dirty set phase 1 produces, and
  // phase 3 diffs against a candidate DB that doesn't exist until the
  // remote snapshot has been fetched, so no amount of counting could have
  // known the total up front. Summing them was also apples-to-oranges --
  // a gigabyte hashed off a local disk and a gigabyte pushed over an
  // uplink are not the same work -- which made the single combined ETA
  // partly fiction. Three bars, each with a real denominator and a real
  // ETA over homogeneous work, are both simpler and more honest.
  //
  // Each phase asks for its bar when it actually starts, so a phase whose
  // inputs don't exist yet never renders an empty bar claiming otherwise.
  const phaseProgress = (label: string): OnProgress | undefined => onPhase?.(label);

  try {
    const cacheRepo = new CacheEntriesRepository(cacheDb);
    // A single repo/connection now covers both reads and writes:
    // CacheEntriesRepository.iterateDirty() is keyset-paginated (src/db/
    // keyset-pagination.ts), not a live `.iterate()` cursor, so
    // reconciliation's writes below can safely interleave with iterating
    // the dirty set on the same connection -- a write only ever conflicts
    // with a *paused* cursor, and pagination never leaves one paused
    // between pages.
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
          new IgnorePoliciesRepository(stateDbForScan),
          lastSyncedVersion,
          logger,
          pools.hashRunner,
          pools.hash.maxThreads,
          phaseProgress("scanning"),
        );
      } finally {
        stateDbForScan.close();
      }
    }

    const dirtyCount = cacheRepo.countDirty();

    const currentKey = remoteKey(s3.location, CURRENT_POINTER_KEY);
    // Retried like the transfers are: these metadata requests are small but
    // they bracket the expensive part of a run, and losing a completed
    // 700 GB upload to a blip on the /current fetch is the worst version of
    // the bug this whole item exists to fix. Safe to retry unconditionally
    // because every one of them is idempotent -- two pure reads, and a PUT
    // of identical bytes to a key derived from this run's own version stamp.
    const current = await withS3Retry(() => getObject(s3.client, s3.bucket, currentKey), {
      onRetry: retryLogger(logger, "fetching the /current pointer"),
    });
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
      const snapshot = await withS3Retry(
        () =>
          getObject(
            s3.client,
            s3.bucket,
            remoteKey(s3.location, stateSnapshotKey(remoteVersionStamp)),
          ),
        { onRetry: retryLogger(logger, "fetching the remote state.db snapshot") },
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
      let localResult, remoteResult, willCommit;
      try {
        // excludePaths is filled in as a side effect of the same pass that
        // feeds applyLocalChangesToCandidate, rather than a second read --
        // it needs every dirty path (not just handled ones), which isn't
        // known until this loop actually runs.
        const excludePaths = new Set<string>();
        // A second, independent walk of the same dirty set -- pure SQL, no
        // filesystem and no network -- so the upload bar opens with a real
        // denominator instead of one that grows as rows are consumed.
        // Safe on this shared connection: iterateDirty() is keyset-
        // paginated, never a paused cursor (see the note above).
        const uploadTotals = enumerateUploadWork(
          cacheRepo.iterateDirty(),
          new ObjectsRepository(candidateDb),
        );
        localResult = await applyLocalChangesToCandidate(
          candidateDb,
          tapPaths(cacheRepo.iterateDirty(), excludePaths),
          root,
          masterKey,
          versionStamp,
          s3,
          logger,
          pools.stream,
          pools.stream.concurrency * 2,
          phaseProgress("uploading"),
          uploadTotals,
        );

        // A version is only worth committing if something *actually*
        // mutated entries/objects -- a sync where every dirty row resolved
        // as a no-op (see conflict-rules.ts) has nothing new to upload.
        willCommit = localResult.appliedCount > 0;

        // Diffs cache.db directly against the candidate (remote + this
        // machine's own successful edits) -- see apply-remote-changes.ts
        // for why version-stamp comparison alone isn't the right basis.
        remoteResult = await applyRemoteChangesToLocal(
          candidateDb,
          root,
          masterKey,
          cacheRepo,
          excludePaths,
          s3,
          logger,
          pools.stream,
          pools.stream.concurrency * 2,
          phaseProgress("downloading"),
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
          filterByPath(cacheRepo.iterateDirty(), localResult.handledPaths),
          localResult.handledPaths,
        );

        const remoteTotal = remoteResult.created + remoteResult.modified + remoteResult.deleted;
        const nothingToSync =
          dirtyCount === 0 && remoteTotal === 0 && localResult.conflicts.length === 0;

        return {
          // No new version was minted, so the baseline this machine now sits
          // at is whatever the remote holds (unchanged from
          // `lastSyncedVersion` when the remote hadn't moved either).
          versionStamp: remoteVersionStamp,
          nothingToSync,
          uploadedObjects: 0,
          dedupedObjects: 0,
          localEntriesChanged: localResult.handledPaths.size,
          remoteCreated: remoteResult.created,
          remoteModified: remoteResult.modified,
          remoteDeleted: remoteResult.deleted,
          conflicts: localResult.conflicts,
          caseCollisions: updateCacheStats.caseCollisions,
          ignoredButSynced: remoteResult.ignoredButSynced,
        };
      }

      const candidateBytes = fs.readFileSync(candidatePath);
      const stateContext = randomBytes(16); // non-convergent: state.db isn't content-addressed
      const encryptedStateDb = encryptBuffer(candidateBytes, masterKey, stateContext);

      logger.debug({ versionStamp }, "uploading candidate state.db snapshot");
      await withS3Retry(
        () =>
          putObject(
            s3.client,
            s3.bucket,
            remoteKey(s3.location, stateSnapshotKey(versionStamp)),
            encryptedStateDb,
          ),
        { onRetry: retryLogger(logger, "uploading the state.db snapshot") },
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
        filterByPath(cacheRepo.iterateDirty(), localResult.handledPaths),
        localResult.handledPaths,
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
        ignoredButSynced: remoteResult.ignoredButSynced,
      };
    } finally {
      if (fs.existsSync(candidatePath)) fs.rmSync(candidatePath);
      if (remoteFreshIsTemp && fs.existsSync(remoteFreshPath)) fs.rmSync(remoteFreshPath);
    }
  } finally {
    cacheDb.close();
  }
}
