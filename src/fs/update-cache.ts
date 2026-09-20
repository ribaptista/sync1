import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";
import { walk, type WalkEntry } from "./walker.js";
import { readStubHash, stubPathFor, StubFormatError } from "./stub.js";
import { CorruptionError } from "../errors.js";
import { tempSiblingPath } from "./temp-path.js";
import type { ObjectsRepository } from "../db/repositories/objects-repository.js";
import {
  CacheEntriesRepository,
  type CacheEntryRow,
} from "../db/repositories/cache-entries-repository.js";
import { StagingRepository } from "../db/repositories/staging-repository.js";
import { toCollisionKey } from "./case-collision.js";
import { matchesAnyGlob } from "./glob-match.js";
import type { IgnorePoliciesRepository } from "../db/repositories/ignore-policies-repository.js";
import { BoundedTaskTracker } from "../concurrency/pools.js";
import type { HashRunner } from "../concurrency/hash-runner.js";
import { createProgressTracker, type OnProgress, type ProgressTracker } from "../progress-types.js";
import { enumerateUpdateCacheWork, type EnumerationControl } from "./update-cache-enumerate.js";

export interface CaseCollision {
  path: string;
  collidesWith: string;
}

export interface UpdateCacheStats {
  created: number;
  modified: number;
  deleted: number;
  unchanged: number;
  /** A brand-new local path matching an ignore policy -- never staged into cache.db at all, so there's no row for it to name. */
  ignored: number;
  /**
   * A path already sitting in cache.db, uncommitted (`state === 'created'`
   * -- never synced), whose content a policy created *after* it was first
   * discovered now matches -- dropped (`cacheRepo.delete`) rather than left
   * to be uploaded on the next `sync`. Named explicitly, not just counted:
   * unlike `ignored` above, this is a row the user might reasonably expect
   * was already on its way in, so which paths it was matters.
   *
   * Deliberately never a committed row (`'unchanged'`/`'modified'`): a
   * local drop there would be indistinguishable from a local delete and
   * would propagate as one to every other machine on the next sync. See
   * docs/architecture/ignore-and-storage-policies.md.
   */
  droppedIgnored: string[];
  caseCollisions: CaseCollision[];
}

export class UnknownStubContentError extends CorruptionError {
  constructor(entryPath: string, hash: string) {
    super(
      `stub for "${entryPath}" references content hash ${hash}, which isn't known in this vault`,
    );
    this.name = "UnknownStubContentError";
  }
}

/**
 * Streaming merge-join between the sorted filesystem walk and cache.db's
 * sorted entries — advances both sides in lockstep by comparing paths,
 * never loading the full dataset into memory. See docs/architecture/
 * cache-and-filesystem-scanning.md for the full state-machine writeup, and
 * docs/architecture/stub-files.md for how stub-backed paths are resolved.
 *
 * A real/dangling-stub file needing a content hash is *dispatched* to
 * `hashRunner` rather than awaited inline: the merge-join loop advances to
 * the next path immediately, while up to `maxInFlightHashes` hash jobs run
 * concurrently in the background (see src/concurrency/pools.ts's
 * BoundedTaskTracker for the backpressure discipline this relies on — the
 * merge-join loop is the producer, and it never gets more than that many
 * jobs ahead of what the hash pool can actually run). Each job's own
 * completion builds its row and inserts it into the staging table directly
 * — see below for why that table's role doesn't change here.
 *
 * Writes are deferred to a second pass after the comparison loop (and every
 * dispatched hash job) finishes: better-sqlite3 refuses to run another
 * statement on the same connection while a `.iterate()` cursor is still
 * open, so `cacheRepo.upsert()` can't be called mid-loop. But that's not
 * actually why staging exists — case-collision detection needs to see the
 * *whole* batch before any row is safely committed (a row later found to
 * collide must never have been written at all), so the deferred-write role
 * would be required even without that connection constraint. The staging
 * table itself is bounded by how much actually *changed*, not by the size
 * of the tree — a scan over a huge, mostly-untouched library still only
 * buffers a handful of rows — and is itself keyset-paginated when read back
 * (src/db/repositories/staging-repository.ts), so it's never materialized
 * into memory either.
 */
export async function performUpdateCache(
  root: string,
  cacheDbPath: string,
  cacheRepo: CacheEntriesRepository,
  objectsRepo: ObjectsRepository,
  ignorePoliciesRepo: IgnorePoliciesRepository,
  lastSyncedVersion: string,
  logger: Logger,
  hashRunner: HashRunner,
  maxInFlightHashes: number,
  onProgress?: OnProgress,
): Promise<UpdateCacheStats> {
  const stats: UpdateCacheStats = {
    created: 0,
    modified: 0,
    deleted: 0,
    unchanged: 0,
    ignored: 0,
    droppedIgnored: [],
    caseCollisions: [],
  };

  // Loaded once, up front: the list itself is expected to be tiny, and
  // matching against it happens in memory either way (there's no SQL GLOB
  // anywhere in this codebase, see docs/architecture/ignore-and-storage-
  // policies.md) -- preloading just avoids re-evaluating the same small
  // pattern list from scratch per path, and this loop's other side (the
  // filesystem walk) was never SQL rows to begin with.
  const ignoreGlobs = ignorePoliciesRepo.listGlobs();

  const stagingPath = tempSiblingPath(cacheDbPath, "update-cache-staging");
  const staging = new StagingRepository(stagingPath);
  const hashJobs = new BoundedTaskTracker(maxInFlightHashes);

  // filesDone/filesTotal track every row the merge-join consumes (work-
  // needing or not, mirroring this scan's pre-existing "scanned" counter);
  // bytesDone/bytesTotal track only content actually hashed this run --
  // see progress-types.ts's own doc comment for the full rule.
  // rowDiscovered() fires once per merge-join step, at the top of the loop
  // below; rowResolved() fires wherever that step's work actually finishes
  // -- immediately for a synchronous row (ignored, tombstoned, dir,
  // already-resolved content), or deferred into dispatchHash's own
  // completion for a row that needed a real hash.
  const progress = createProgressTracker(onProgress, ["hashing", "hashed"]);

  // Started before the real pass and deliberately not awaited here: it
  // counts the same work without dispatching any of it, so it runs at the
  // filesystem's pace rather than the hash pool's and has the totals long
  // before the loop below could discover them. Never rejects; `control`
  // is how the `finally` cuts it short if this run ends first (or fails).
  const enumerationControl: EnumerationControl = { stop: false };
  const enumeration = enumerateUpdateCacheWork(
    root,
    cacheRepo,
    ignoreGlobs,
    progress,
    logger,
    enumerationControl,
  );

  try {
    const fsIter = walk(root);
    const cacheIter = cacheRepo.iterateAllSortedByPath();

    let fsNext = await fsIter.next();
    let cacheNext = cacheIter.next();

    while (!fsNext.done || !cacheNext.done) {
      const fsEntry = fsNext.done ? null : fsNext.value;
      const cacheEntry = cacheNext.done ? null : cacheNext.value;

      progress.rowDiscovered();

      if (fsEntry !== null && (cacheEntry === null || fsEntry.path < cacheEntry.path)) {
        const ignoreMatch = matchesAnyGlob(fsEntry.path, ignoreGlobs);
        if (ignoreMatch.matched) {
          stats.ignored++;
          logger.debug(
            { path: fsEntry.path, pattern: ignoreMatch.pattern },
            "path matches an ignore policy -- skipping",
          );
          progress.rowResolved();
        } else {
          await dispatchCreatedRow(
            fsEntry,
            root,
            lastSyncedVersion,
            objectsRepo,
            stats,
            logger,
            hashRunner,
            hashJobs,
            staging,
            progress,
          );
        }
        fsNext = await fsIter.next();
      } else if (cacheEntry !== null && (fsEntry === null || cacheEntry.path < fsEntry.path)) {
        const row = buildMissingFromFsRow(cacheEntry, stats, logger);
        if (row) staging.insert(row);
        progress.rowResolved();
        cacheNext = cacheIter.next();
      } else if (fsEntry !== null && cacheEntry !== null) {
        // Only ever checked for an uncommitted row: 'unchanged'/'modified'
        // means this path already exists in the shared vault, and dropping
        // its cache row locally would be indistinguishable from a local
        // delete -- propagating as one to every other machine on the next
        // sync. An ignore policy created after a path was first discovered
        // never retroactively un-tracks something already committed; it
        // only ever stops something not yet sent from being sent.
        const ignoreMatch =
          cacheEntry.state === "created" ? matchesAnyGlob(fsEntry.path, ignoreGlobs) : undefined;
        if (ignoreMatch?.matched) {
          // Deleted immediately, not deferred to an apply-after-the-loop
          // step the way staged rows are: cacheIter is keyset-paginated
          // (src/db/keyset-pagination.ts), not a live cursor, and keyset
          // pagination only ever asks for rows *after* the last path it
          // already consumed -- deleting the row this exact step just read
          // can't perturb what a later page's own query returns.
          cacheRepo.delete(fsEntry.path);
          stats.droppedIgnored.push(fsEntry.path);
          logger.debug(
            { path: fsEntry.path, pattern: ignoreMatch.pattern },
            "uncommitted path now matches an ignore policy -- dropping from cache.db",
          );
          progress.rowResolved();
        } else {
          await dispatchExistingRow(
            fsEntry,
            cacheEntry,
            root,
            objectsRepo,
            stats,
            logger,
            hashRunner,
            hashJobs,
            staging,
            progress,
          );
        }
        fsNext = await fsIter.next();
        cacheNext = cacheIter.next();
      }
    }

    // Every dispatched hash job must have inserted its row (or thrown) before
    // case-collision detection can trust the staging table's contents.
    await hashJobs.onIdle();

    const { excludedPaths, collisions } = detectCaseCollisions(staging, cacheRepo);
    stats.caseCollisions = collisions;
    if (collisions.length > 0) {
      logger.warn({ collisions }, "case-insensitive path collision(s) detected -- not applying");
    }

    for (const row of staging.iterateAll()) {
      if (excludedPaths.has(row.path)) continue;
      cacheRepo.upsert(row);
    }
  } finally {
    // Joined before settling, not after: an enumeration still publishing
    // estimates after settle() would push the denominator back up off a
    // just-completed bar. Setting `stop` first means a failed run isn't
    // held open for the remainder of a full second walk.
    enumerationControl.stop = true;
    await enumeration;
    progress.settle();

    staging.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = `${stagingPath}${suffix}`;
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  }

  return stats;
}

/**
 * Finds every case-insensitive collision in this run's batch, both within
 * the batch itself (two paths newly staged as live at once) and against
 * cache.db's existing durable rows (a newly-staged path colliding with
 * something already tracked from an earlier scan) -- and returns which
 * paths to leave unapplied. A durable hit doesn't count if that same path
 * is *also* being tombstoned ('deleted') in this same batch: that's the
 * ordinary "rename" case (delete `file.txt`, create `FILE.txt`), not a
 * real collision. See docs/architecture/cross-platform-filesystem.md.
 */
function detectCaseCollisions(
  staging: StagingRepository,
  cacheRepo: CacheEntriesRepository,
): { excludedPaths: Set<string>; collisions: CaseCollision[] } {
  const excludedPaths = new Set<string>();
  const collisions: CaseCollision[] = [];

  for (const normalizedPath of staging.liveCollisionGroups()) {
    const rows = staging.liveRowsForNormalizedPath(normalizedPath);
    for (const row of rows) {
      const other = rows.find((r) => r.path !== row.path);
      if (!other) continue; // can't happen given liveCollisionGroups()'s own COUNT(*) > 1
      excludedPaths.add(row.path);
      collisions.push({ path: row.path, collidesWith: other.path });
    }
  }

  // Streamed, not materialized: this run's changeset can be as large as
  // the whole tree (a first-ever scan), so neither the staged rows nor a
  // "which paths are tombstoned this batch" set are held in memory --
  // `isDeletedInBatch` queries the (disk-backed) staging table directly
  // per row instead. Safe to run mid-stream because `staging.iterateAll()`
  // is keyset-paginated: each page is fully fetched (connection free)
  // before any of its rows are yielded, so this per-row query never runs
  // while a cursor is paused.
  for (const row of staging.iterateAll()) {
    if (row.state === "deleted" || excludedPaths.has(row.path)) continue;
    const hit = cacheRepo.findByNormalizedPath(toCollisionKey(row.path), row.path);
    if (hit && !staging.isDeletedInBatch(hit.path)) {
      excludedPaths.add(row.path);
      collisions.push({ path: row.path, collidesWith: hit.path });
    }
  }

  return { excludedPaths, collisions };
}

type ContentResolution =
  | { kind: "resolved"; hash: string | null; size: number | null }
  | { kind: "needs-hash"; absolutePath: string };

/**
 * Synchronously classifies a walked file/dir entry, handling all three
 * representations uniformly:
 *  - "real": needs an actual content hash -- dispatched to hashRunner by the
 *    caller, never computed here.
 *  - "stub": read the stub's self-declared hash -- never hash the stub's
 *    own (contentless) bytes -- and validate it against known objects, so
 *    a stub can never silently reference content this vault has never
 *    actually backed up. Resolved immediately, no hash job needed. Its size
 *    comes from the referenced object's own row, never from `fsEntry.size`
 *    -- for a stub-only path, the walker's stat targets the tiny stub file
 *    itself (just a tagged hash string), not the real content it refers to.
 *  - "both" (a dangling stub next to its now-materialized real file, e.g.
 *    from an interrupted `materialize`): the real file always wins: clean
 *    up the stray stub as a side effect (so this doesn't keep resurfacing
 *    on every future scan), then needs a hash of the real file like any
 *    other real file.
 */
function classifyContent(
  fsEntry: WalkEntry,
  root: string,
  objectsRepo: ObjectsRepository,
  logger: Logger,
): ContentResolution {
  const absolutePath = path.join(root, fsEntry.path);

  if (fsEntry.type === "dir") return { kind: "resolved", hash: null, size: null };

  if (fsEntry.representation === "both") {
    const stubAbsolutePath = stubPathFor(absolutePath);
    try {
      fs.rmSync(stubAbsolutePath);
      logger.warn(
        { path: fsEntry.path },
        "both a stub and the real file exist -- ignoring the stub and deleting it",
      );
    } catch {
      // already gone by the time we got here -- fine
    }
    return { kind: "needs-hash", absolutePath };
  }

  if (fsEntry.representation === "stub") {
    let hash: string;
    try {
      hash = readStubHash(stubPathFor(absolutePath));
    } catch (err) {
      if (err instanceof StubFormatError) {
        throw new CorruptionError(`corrupt stub at "${fsEntry.path}.stub": ${err.message}`);
      }
      throw err;
    }
    const objectRow = objectsRepo.get(hash);
    if (!objectRow) {
      throw new UnknownStubContentError(fsEntry.path, hash);
    }
    return { kind: "resolved", hash, size: objectRow.size };
  }

  return { kind: "needs-hash", absolutePath };
}

/**
 * Dispatches one file's hash job through `hashJobs`, logging its dispatch
 * and completion with the pool's current occupancy -- this is what lets an
 * e2e test observe real concurrency (via --verbose's structured stderr
 * output) rather than only final correctness, which can't distinguish a
 * correctly-bounded pool from an accidentally-sequential one.
 */
async function dispatchHash(
  hashJobs: BoundedTaskTracker,
  hashRunner: HashRunner,
  absolutePath: string,
  relativePath: string,
  size: number,
  logger: Logger,
  progress: ProgressTracker,
  onResolved: (hash: string) => void,
): Promise<void> {
  progress.expectBytes(size);
  await hashJobs.dispatch(async () => {
    // The vault-relative path, not absolutePath: this one is rendered on
    // the progress bar, where a long absolute prefix would be truncated
    // away to leave a useless fragment. It also matches how every log line
    // in here already names a path.
    const fileTracker = progress.startFile(relativePath, size);
    try {
      const hash = await hashRunner.run(absolutePath, (n) => fileTracker.advance(n));
      onResolved(hash);
      logger.debug({ pool: "hash", inFlight: hashJobs.size }, "completed");
    } finally {
      // Unconditional, per FileTracker's own contract -- a rejected job's
      // cleanup path (caught by BoundedTaskTracker, not here) must never
      // leave this file's share of inFlightBytes pinned for the rest of
      // the run. rowResolved() lives here too: dispatchHash always speaks
      // for exactly one row (update-cache.ts never shares a hash job
      // across rows the way apply-local-changes.ts's dedup attach does),
      // so "this row's async work resolved" and "this hash job settled"
      // are the same event, success or failure alike.
      fileTracker.finish();
      progress.rowResolved();
    }
  });
  logger.debug({ pool: "hash", inFlight: hashJobs.size }, "dispatched");
}

async function dispatchCreatedRow(
  fsEntry: WalkEntry,
  root: string,
  lastSyncedVersion: string,
  objectsRepo: ObjectsRepository,
  stats: UpdateCacheStats,
  logger: Logger,
  hashRunner: HashRunner,
  hashJobs: BoundedTaskTracker,
  staging: StagingRepository,
  progress: ProgressTracker,
): Promise<void> {
  const mtime = Math.round(fsEntry.mtimeMs);
  const resolution = classifyContent(fsEntry, root, objectsRepo, logger);

  const finalize = (hash: string | null, size: number | null): void => {
    stats.created++;
    logger.debug({ path: fsEntry.path, type: fsEntry.type }, "new path detected");
    staging.insert({
      path: fsEntry.path,
      type: fsEntry.type,
      mtime,
      hash,
      size,
      state: "created",
      parent_state_version: lastSyncedVersion,
    });
  };

  if (resolution.kind === "resolved") {
    finalize(resolution.hash, resolution.size);
    progress.rowResolved();
    return;
  }

  // needs-hash only ever happens for a real (or dangling-both) file, where
  // the walker's own stat targeted that real file -- fsEntry.size is
  // correct here, unlike the stub-resolved case above. dispatchHash calls
  // progress.rowResolved() itself once the hash job settles.
  await dispatchHash(
    hashJobs,
    hashRunner,
    resolution.absolutePath,
    fsEntry.path,
    fsEntry.size,
    logger,
    progress,
    (hash) => finalize(hash, fsEntry.size),
  );
}

function buildMissingFromFsRow(
  cacheEntry: CacheEntryRow,
  stats: UpdateCacheStats,
  logger: Logger,
): CacheEntryRow | null {
  if (cacheEntry.state === "deleted") {
    // Already a pending tombstone from a prior run -- idempotent no-op, and
    // deliberately not counted: `deleted` reports transitions this scan
    // actually made, the same way created/modified do. Counting it here too
    // made a re-scan claim deletions it never wrote.
    return null;
  }
  stats.deleted++;
  logger.debug({ path: cacheEntry.path }, "path no longer exists on disk");
  return {
    path: cacheEntry.path,
    type: cacheEntry.type,
    mtime: null,
    hash: null,
    size: null,
    state: "deleted",
    // Carried over, never re-stamped from the run's `lastSyncedVersion`:
    // this row's baseline means "the version at which *this path* was last
    // written in state.db", which is what conflict-rules.ts compares it
    // against. The run-wide version advances on any commit at all --
    // including policy mutations that never touch `entries` -- so adopting
    // it here made the next sync see a mismatch and cry "modified
    // remotely". See docs/architecture/conflict-resolution.md.
    parent_state_version: cacheEntry.parent_state_version,
  };
}

async function dispatchExistingRow(
  fsEntry: WalkEntry,
  cacheEntry: CacheEntryRow,
  root: string,
  objectsRepo: ObjectsRepository,
  stats: UpdateCacheStats,
  logger: Logger,
  hashRunner: HashRunner,
  hashJobs: BoundedTaskTracker,
  staging: StagingRepository,
  progress: ProgressTracker,
): Promise<void> {
  const newMtime = Math.round(fsEntry.mtimeMs);

  if (fsEntry.type === "dir") {
    // Directories carry no content -- existence is the only signal. A
    // prior 'deleted' tombstone reappearing is a fresh creation; anything
    // else is left exactly as it already was (never downgraded away from
    // a still-pending created/modified state just because it still exists).
    if (cacheEntry.state === "deleted") {
      stats.created++;
      logger.debug({ path: fsEntry.path }, "directory recreated after deletion");
      staging.insert({
        path: fsEntry.path,
        type: "dir",
        mtime: newMtime,
        hash: null,
        size: null,
        state: "created",
        parent_state_version: cacheEntry.parent_state_version,
      });
      progress.rowResolved();
      return;
    }
    stats.unchanged++;
    progress.rowResolved();
    return;
  }

  // A dangling stub is always worth resolving (and cleaning up) even if
  // the real file's mtime happens to match the recorded baseline -- the
  // walker already paid for the stat that revealed "both", so this isn't
  // adding new I/O, just not throwing that information away.
  const danglingStub = fsEntry.representation === "both";

  // Otherwise: only re-resolve (rehash, or re-read+validate a stub) when
  // mtime actually differs, so an untouched multi-GB video is never
  // re-read, and a steady-state stub is never re-validated, on every scan.
  if (!danglingStub && cacheEntry.mtime === newMtime) {
    stats.unchanged++;
    progress.rowResolved();
    return;
  }

  const resolution = classifyContent(fsEntry, root, objectsRepo, logger);

  const finalize = (newHash: string | null, size: number | null): void => {
    if (newHash === cacheEntry.hash) {
      // mtime noise only (e.g. a bare touch, or a cleaned-up dangling stub
      // that referenced the same content) -- refresh the baseline mtime, no
      // real content change, so don't disturb whatever state it already had
      // (size is unchanged too, already correct via the spread below)
      stats.unchanged++;
      staging.insert({ ...cacheEntry, mtime: newMtime });
      return;
    }

    logger.debug({ path: fsEntry.path, oldHash: cacheEntry.hash, newHash }, "file content changed");

    if (cacheEntry.state === "unchanged" || cacheEntry.state === "deleted") {
      // Establishing a brand-new pending change. The baseline carries over
      // from the row's existing one rather than being re-stamped with this
      // run's `lastSyncedVersion` -- see buildMissingFromFsRow for why that
      // distinction matters.
      const newState = cacheEntry.state === "deleted" ? "created" : "modified";
      stats[newState]++;
      staging.insert({
        path: fsEntry.path,
        type: "file",
        mtime: newMtime,
        hash: newHash,
        size,
        state: newState,
        parent_state_version: cacheEntry.parent_state_version,
      });
      return;
    }

    // already pending (created/modified): content changed again before
    // syncing -- keep the original baseline, just refresh hash/mtime/size
    stats[cacheEntry.state]++;
    staging.insert({ ...cacheEntry, mtime: newMtime, hash: newHash, size });
  };

  if (resolution.kind === "resolved") {
    finalize(resolution.hash, resolution.size);
    progress.rowResolved();
    return;
  }

  // needs-hash only ever happens for a real (or dangling-both) file, where
  // the walker's own stat targeted that real file -- fsEntry.size is
  // correct here, unlike the stub-resolved case above. dispatchHash calls
  // progress.rowResolved() itself once the hash job settles.
  await dispatchHash(
    hashJobs,
    hashRunner,
    resolution.absolutePath,
    fsEntry.path,
    fsEntry.size,
    logger,
    progress,
    (hash) => finalize(hash, fsEntry.size),
  );
}
