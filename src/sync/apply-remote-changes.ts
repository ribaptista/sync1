import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import type PQueue from "p-queue";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";
import { EntriesRepository, type EntryRow } from "../db/repositories/entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import { IgnorePoliciesRepository } from "../db/repositories/ignore-policies-repository.js";
import { matchesAnyGlob } from "../fs/glob-match.js";
import { CryptoAuthError } from "../crypto/chunked-codec.js";
import { getObjectStream } from "../s3/client.js";
import { remoteKey, type RemoteLocation } from "../vault/paths.js";
import { writeStubAtomic, stubPathFor } from "../fs/stub.js";
import { CorruptionError } from "../errors.js";
import { decryptStreamToFile } from "../fs/decrypt-to-file.js";
import { waitForRoom } from "../concurrency/pools.js";
import { createProgressTracker, type OnProgress, type ProgressTracker } from "../progress-types.js";

/**
 * A path materialized (or stub-updated) here despite matching a global
 * ignore policy -- always content this machine already shared before the
 * policy existed (or before this machine had synced it). Ignore policies
 * gate new local creations only; they never retroactively un-share content
 * already committed to the vault, so this is a warning, not a failure.
 */
export interface IgnoredButSyncedEntry {
  path: string;
  matchedGlob: string;
}

export interface ApplyRemoteChangesResult {
  created: number;
  modified: number;
  deleted: number;
  ignoredButSynced: IgnoredButSyncedEntry[];
}

/**
 * Diffs cache.db's *current* content directly against the candidate
 * state.db (which, by the time this runs, already reflects remote's latest
 * plus this machine's own successfully-applied local edits) to find every
 * path that isn't already correctly materialized locally, and applies each
 * to the filesystem + cache.db.
 *
 * This deliberately does NOT compare two state.db snapshots by version
 * stamp -- a version-stamp comparison is the wrong basis. Right after a
 * fresh attach_remote, local state.db is already fully populated (fetched)
 * but cache.db is completely empty (nothing materialized yet), so "has the
 * version stamp changed" says no while everything still needs downloading.
 * Diffing cache.db's actual hashes against the candidate's is what's
 * actually true regardless of *why* they diverged.
 *
 * A brand-new path (never in cache.db before) defaults to a **stub**, not a
 * full download -- this is what makes attach_remote + sync a real restore
 * without downloading the whole backup. An already-known path preserves
 * whatever representation it currently has: already-stubbed stays a stub
 * (just its referenced hash is updated, no download at all); already
 * materialized stays materialized (downloads the new content).
 *
 * Only that last case -- an already-materialized path whose remote content
 * changed -- involves any real I/O worth parallelizing (directory creation
 * and stub writes are cheap, synchronous, and stay that way). Such a
 * download is *dispatched* to `streamPool` rather than awaited inline: the
 * merge-join loop advances to the next path immediately, and up to
 * `streamQueueLimit` downloads run concurrently in the background, joined
 * via `streamPool.onIdle()` before this function returns. No in-memory
 * ledger/bookkeeping is needed for this pass the way apply-local-changes.ts
 * needs one -- this function does no cross-row collision or dedup
 * detection of its own, so a dispatched download never needs to be looked
 * up again by a later row.
 *
 * `excludePaths` (this machine's own dirty rows) are skipped entirely --
 * handled by apply-local-changes.ts instead, or deliberately left
 * conflicted; this function never overwrites a file the user has a pending
 * edit to. Reads and writes both go through the caller's own `cacheRepo` --
 * a second connection isn't needed: `CacheEntriesRepository.
 * iterateAllSortedByPath()` is keyset-paginated (src/db/keyset-
 * pagination.ts), not a live `.iterate()` cursor, so `cacheRepo.upsert()`/
 * `.delete()` can safely interleave with it on the same connection (a
 * write only ever conflicts with a *paused* cursor on that connection,
 * and pagination never leaves one paused between pages).
 */
export async function applyRemoteChangesToLocal(
  candidateDb: Database.Database,
  root: string,
  masterKey: Buffer,
  cacheRepo: CacheEntriesRepository,
  excludePaths: ReadonlySet<string>,
  s3: { client: S3Client; bucket: string; location: RemoteLocation },
  logger: Logger,
  streamPool: PQueue,
  streamQueueLimit: number,
  onProgress?: OnProgress,
): Promise<ApplyRemoteChangesResult> {
  const candidateEntries = new EntriesRepository(candidateDb);
  const candidateObjects = new ObjectsRepository(candidateDb);
  const ignoreGlobs = new IgnorePoliciesRepository(candidateDb).listGlobs();

  // filesDone/filesTotal track every path the merge-join consumes (work-
  // needing or not, mirroring other commands' "scanned" counter);
  // bytesDone/bytesTotal track only an actual download -- see
  // progress-types.ts's own doc comment for the full rule. rowDiscovered()
  // fires once per merge-join step, at the top of the loop below;
  // rowResolved() fires immediately for a synchronous outcome (excluded,
  // deleted, a directory, a stub write) and is deferred into
  // applyRemoteContentChange's own download-completion point for a path
  // whose remote content actually needs downloading.
  const progress = createProgressTracker(onProgress, ["downloading", "downloaded"]);

  {
    const cacheIter = cacheRepo.iterateAllSortedByPath();
    const candidateIter = candidateEntries.iterateAllSortedByPath();

    let cacheNext = cacheIter.next();
    let candidateNext = candidateIter.next();

    const result: ApplyRemoteChangesResult = {
      created: 0,
      modified: 0,
      deleted: 0,
      ignoredButSynced: [],
    };

    while (!cacheNext.done || !candidateNext.done) {
      const cacheEntry = cacheNext.done ? null : cacheNext.value;
      const candidateEntry = candidateNext.done ? null : candidateNext.value;

      progress.rowDiscovered();

      if (
        candidateEntry !== null &&
        (cacheEntry === null || candidateEntry.path < cacheEntry.path)
      ) {
        // Not tracked in cache.db at all -- either genuinely new remotely,
        // or (the attach_remote case) never materialized locally yet.
        // Either way: default to a stub, never a download.
        if (!excludePaths.has(candidateEntry.path)) {
          // Always resolves synchronously within itself -- writeAsStub is
          // hardcoded true here, so applyRemoteContentChange never reaches
          // its own download branch for a brand-new path -- but it still
          // owns calling rowResolved(), same as the modified branch below,
          // so both call sites stay uniform.
          await applyRemoteContentChange(
            candidateEntry,
            root,
            masterKey,
            candidateObjects,
            cacheRepo,
            true,
            s3,
            logger,
            streamPool,
            streamQueueLimit,
            progress,
          );
          result.created++;

          const ignoreMatch = matchesAnyGlob(candidateEntry.path, ignoreGlobs);
          if (ignoreMatch.matched) {
            result.ignoredButSynced.push({
              path: candidateEntry.path,
              matchedGlob: ignoreMatch.pattern!,
            });
            logger.warn(
              { path: candidateEntry.path, pattern: ignoreMatch.pattern },
              "path matches a global ignore policy but was already shared before the policy applied -- materializing anyway",
            );
          }
        } else {
          progress.rowResolved();
        }
        candidateNext = candidateIter.next();
      } else if (
        cacheEntry !== null &&
        (candidateEntry === null || cacheEntry.path < candidateEntry.path)
      ) {
        // Tracked locally but gone from state.db -- deleted remotely.
        // Always synchronous, excluded or not, so rowResolved() is never
        // deferred here.
        if (!excludePaths.has(cacheEntry.path)) {
          applyRemoteDelete(cacheEntry.path, cacheEntry.type, root, cacheRepo, logger);
          result.deleted++;
        }
        progress.rowResolved();
        cacheNext = cacheIter.next();
      } else if (cacheEntry !== null && candidateEntry !== null) {
        if (!excludePaths.has(candidateEntry.path) && cacheEntry.hash !== candidateEntry.hash) {
          // Already known locally: preserve whatever representation is
          // currently on disk rather than the default-to-stub policy above.
          // applyRemoteContentChange owns rowResolved() here -- this is the
          // one path that can genuinely dispatch a real download.
          const preserveAsStub = currentlyStubBacked(root, candidateEntry.path);
          await applyRemoteContentChange(
            candidateEntry,
            root,
            masterKey,
            candidateObjects,
            cacheRepo,
            preserveAsStub,
            s3,
            logger,
            streamPool,
            streamQueueLimit,
            progress,
          );
          result.modified++;
        } else {
          progress.rowResolved();
        }
        cacheNext = cacheIter.next();
        candidateNext = candidateIter.next();
      }
    }

    await streamPool.onIdle();

    return result;
  }
}

function currentlyStubBacked(root: string, entryPath: string): boolean {
  const absolutePath = path.join(root, entryPath);
  return !fs.existsSync(absolutePath) && fs.existsSync(stubPathFor(absolutePath));
}

/**
 * Classifies synchronously (directory / stub write / real download needed),
 * only dispatching to `streamPool` -- rather than awaiting inline -- for the
 * one case that's genuine network I/O: a real download. Directory creation
 * and stub writes are cheap and synchronous, so they're applied immediately
 * and never touch the pool.
 *
 * Every cache row written here takes its `parent_state_version` from
 * `entry.state_version` -- the version at which *this path's* row was last
 * written in state.db -- never from the version of whatever commit happens
 * to be in flight. That's the invariant conflict-rules.ts relies on: it
 * compares a cache row's `parent_state_version` against the candidate
 * entry's own `state_version`, so the two must always be the same kind of
 * thing. See docs/architecture/conflict-resolution.md.
 */
async function applyRemoteContentChange(
  entry: EntryRow,
  root: string,
  masterKey: Buffer,
  candidateObjects: ObjectsRepository,
  cacheRepo: CacheEntriesRepository,
  writeAsStub: boolean,
  s3: { client: S3Client; bucket: string; location: RemoteLocation },
  logger: Logger,
  streamPool: PQueue,
  streamQueueLimit: number,
  progress: ProgressTracker,
): Promise<void> {
  const absolutePath = path.join(root, entry.path);

  if (entry.type === "dir") {
    fs.mkdirSync(absolutePath, { recursive: true });
    cacheRepo.upsert({
      path: entry.path,
      type: "dir",
      mtime: Math.round(fs.statSync(absolutePath).mtimeMs),
      hash: null,
      size: null,
      state: "unchanged",
      parent_state_version: entry.state_version,
    });
    logger.debug({ path: entry.path }, "materialized remote directory");
    progress.rowResolved();
    return;
  }

  if (!entry.hash) throw new Error(`remote entry for "${entry.path}" is a file with no hash`);
  const objectRow = candidateObjects.get(entry.hash);
  if (!objectRow) {
    throw new CorruptionError(
      `remote entry for "${entry.path}" references unknown object hash ${entry.hash}`,
    );
  }

  if (writeAsStub) {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const stubAbsolutePath = stubPathFor(absolutePath);
    writeStubAtomic(stubAbsolutePath, entry.hash);
    cacheRepo.upsert({
      path: entry.path,
      type: "file",
      mtime: Math.round(fs.statSync(stubAbsolutePath).mtimeMs),
      hash: entry.hash,
      // The stub itself has no content bytes -- objectRow.size is the real
      // size of the content it refers to, and is what makes cache.db's size
      // mean "size of this path's current content" regardless of whether
      // it's materialized or only stub-backed.
      size: objectRow.size,
      state: "unchanged",
      parent_state_version: entry.state_version,
    });
    logger.debug(
      { path: entry.path, hash: entry.hash },
      "wrote stub for remote content (no download)",
    );
    progress.rowResolved();
    return;
  }

  const hash = entry.hash;
  progress.expectBytes(objectRow.size);
  await waitForRoom(streamPool, streamQueueLimit);
  void streamPool.add(async () => {
    const fileTracker = progress.startFile(entry.path, objectRow.size);
    try {
      const encrypted = await getObjectStream(
        s3.client,
        s3.bucket,
        remoteKey(s3.location, objectRow.s3_key),
      );
      if (!encrypted) {
        throw new CorruptionError(
          `object ${hash} for "${entry.path}" is missing in S3 (corrupt vault?)`,
        );
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
            `object ${hash} for "${entry.path}" failed decryption/authentication`,
          );
        }
        throw err;
      }
      if (computedHash !== hash) {
        fs.rmSync(tmpPath);
        throw new CorruptionError(
          `object ${hash} for "${entry.path}" does not match its recorded hash`,
        );
      }

      fs.renameSync(tmpPath, absolutePath);

      cacheRepo.upsert({
        path: entry.path,
        type: "file",
        mtime: Math.round(fs.statSync(absolutePath).mtimeMs),
        hash,
        size: objectRow.size,
        state: "unchanged",
        parent_state_version: entry.state_version,
      });
      logger.debug({ path: entry.path, hash }, "materialized remote file create/modify");
      logger.debug(
        { pool: "stream", inFlight: streamPool.pending, queued: streamPool.size },
        "completed",
      );
    } finally {
      // Unconditional, per FileTracker's own contract -- see
      // update-cache.ts's dispatchHash for why this matters even on the
      // error paths above.
      fileTracker.finish();
      progress.rowResolved();
    }
  });
  // Logged after add(), not before -- add() synchronously starts the task
  // (if capacity allows) before returning, so this reflects occupancy
  // *including* the job just dispatched.
  logger.debug(
    { pool: "stream", inFlight: streamPool.pending, queued: streamPool.size },
    "dispatched",
  );
}

function applyRemoteDelete(
  entryPath: string,
  entryType: "file" | "dir",
  root: string,
  cacheRepo: CacheEntriesRepository,
  logger: Logger,
): void {
  const absolutePath = path.join(root, entryPath);
  try {
    if (entryType === "dir") {
      fs.rmdirSync(absolutePath); // best-effort; leaves it if not empty (e.g. conflicted children remain)
    } else {
      fs.rmSync(absolutePath);
    }
  } catch {
    // already gone, or non-empty directory -- not fatal either way
  }
  try {
    fs.rmSync(stubPathFor(absolutePath));
  } catch {
    // no stub -- fine, this was a materialized path
  }
  cacheRepo.delete(entryPath);
  logger.debug({ path: entryPath }, "applied remote deletion");
}
