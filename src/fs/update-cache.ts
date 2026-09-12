import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";
import { walk, type WalkEntry } from "./walker.js";
import { hashFile } from "./hash-file.js";
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

export interface CaseCollision {
  path: string;
  collidesWith: string;
}

export interface UpdateCacheStats {
  created: number;
  modified: number;
  deleted: number;
  unchanged: number;
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
 * Writes are deferred to a second pass after the comparison loop finishes:
 * better-sqlite3 refuses to run another statement on the same connection
 * while a `.iterate()` cursor is still open, so `cacheRepo.upsert()` can't
 * be called mid-loop. The array of pending writes is bounded by how much
 * actually *changed*, not by the size of the tree — a scan over a huge,
 * mostly-untouched library still only buffers a handful of rows.
 */
export async function performUpdateCache(
  root: string,
  cacheDbPath: string,
  cacheRepo: CacheEntriesRepository,
  objectsRepo: ObjectsRepository,
  lastSyncedVersion: string,
  logger: Logger,
  onProgress?: (scanned: number) => void,
): Promise<UpdateCacheStats> {
  const stats: UpdateCacheStats = {
    created: 0,
    modified: 0,
    deleted: 0,
    unchanged: 0,
    caseCollisions: [],
  };

  const stagingPath = tempSiblingPath(cacheDbPath, "update-cache-staging");
  const staging = new StagingRepository(stagingPath);

  try {
    const fsIter = walk(root);
    const cacheIter = cacheRepo.iterateAllSortedByPath();

    let fsNext = await fsIter.next();
    let cacheNext = cacheIter.next();
    let scanned = 0;

    while (!fsNext.done || !cacheNext.done) {
      const fsEntry = fsNext.done ? null : fsNext.value;
      const cacheEntry = cacheNext.done ? null : cacheNext.value;

      if (fsEntry !== null && (cacheEntry === null || fsEntry.path < cacheEntry.path)) {
        staging.insert(
          await buildCreatedRow(fsEntry, root, lastSyncedVersion, objectsRepo, stats, logger),
        );
        fsNext = await fsIter.next();
      } else if (cacheEntry !== null && (fsEntry === null || cacheEntry.path < fsEntry.path)) {
        const row = buildMissingFromFsRow(cacheEntry, lastSyncedVersion, stats, logger);
        if (row) staging.insert(row);
        cacheNext = cacheIter.next();
      } else if (fsEntry !== null && cacheEntry !== null) {
        const row = await buildExistingRow(
          fsEntry,
          cacheEntry,
          root,
          lastSyncedVersion,
          objectsRepo,
          stats,
          logger,
        );
        if (row) staging.insert(row);
        fsNext = await fsIter.next();
        cacheNext = cacheIter.next();
      }

      scanned++;
      onProgress?.(scanned);
    }

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

  // Bounded the same way the whole staging table already is (by what
  // changed this run, not by tree size) -- materializing it here is not a
  // new memory concern, just a second pass over an already-bounded set.
  const allStaged = [...staging.iterateAll()];
  const deletedInBatch = new Set(allStaged.filter((r) => r.state === "deleted").map((r) => r.path));

  for (const row of allStaged) {
    if (row.state === "deleted" || excludedPaths.has(row.path)) continue;
    const hit = cacheRepo.findByNormalizedPath(toCollisionKey(row.path), row.path);
    if (hit && !deletedInBatch.has(hit.path)) {
      excludedPaths.add(row.path);
      collisions.push({ path: row.path, collidesWith: hit.path });
    }
  }

  return { excludedPaths, collisions };
}

interface ResolvedContent {
  hash: string | null;
  mtime: number;
}

/**
 * Resolves a walked file/dir entry to its logical (hash, mtime), handling
 * all three representations uniformly so the create/modify/delete decision
 * logic below never needs to know which one it's looking at:
 *  - "real": hash the actual bytes, as always.
 *  - "stub": read the stub's self-declared hash -- never hash the stub's
 *    own (contentless) bytes -- and validate it against known objects, so
 *    a stub can never silently reference content this vault has never
 *    actually backed up.
 *  - "both" (a dangling stub next to its now-materialized real file, e.g.
 *    from an interrupted `materialize`): the real file always wins: hash
 *    it normally, and clean up the stray stub as a side effect so this
 *    doesn't keep resurfacing on every future scan.
 */
async function resolveFileContent(
  fsEntry: WalkEntry,
  root: string,
  objectsRepo: ObjectsRepository,
  logger: Logger,
): Promise<ResolvedContent> {
  const absolutePath = path.join(root, fsEntry.path);
  const mtime = Math.round(fsEntry.mtimeMs);

  if (fsEntry.type === "dir") return { hash: null, mtime };

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
    return { hash: await hashFile(absolutePath), mtime };
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
    if (!objectsRepo.has(hash)) {
      throw new UnknownStubContentError(fsEntry.path, hash);
    }
    return { hash, mtime };
  }

  return { hash: await hashFile(absolutePath), mtime };
}

async function buildCreatedRow(
  fsEntry: WalkEntry,
  root: string,
  lastSyncedVersion: string,
  objectsRepo: ObjectsRepository,
  stats: UpdateCacheStats,
  logger: Logger,
): Promise<CacheEntryRow> {
  const { hash, mtime } = await resolveFileContent(fsEntry, root, objectsRepo, logger);
  stats.created++;
  logger.debug({ path: fsEntry.path, type: fsEntry.type }, "new path detected");
  return {
    path: fsEntry.path,
    type: fsEntry.type,
    mtime,
    hash,
    state: "created",
    parent_state_version: lastSyncedVersion,
  };
}

function buildMissingFromFsRow(
  cacheEntry: CacheEntryRow,
  lastSyncedVersion: string,
  stats: UpdateCacheStats,
  logger: Logger,
): CacheEntryRow | null {
  stats.deleted++;
  if (cacheEntry.state === "deleted") {
    // already a pending tombstone from a prior run -- idempotent no-op
    return null;
  }
  logger.debug({ path: cacheEntry.path }, "path no longer exists on disk");
  return {
    path: cacheEntry.path,
    type: cacheEntry.type,
    mtime: null,
    hash: null,
    state: "deleted",
    parent_state_version: lastSyncedVersion,
  };
}

async function buildExistingRow(
  fsEntry: WalkEntry,
  cacheEntry: CacheEntryRow,
  root: string,
  lastSyncedVersion: string,
  objectsRepo: ObjectsRepository,
  stats: UpdateCacheStats,
  logger: Logger,
): Promise<CacheEntryRow | null> {
  const newMtime = Math.round(fsEntry.mtimeMs);

  if (fsEntry.type === "dir") {
    // Directories carry no content -- existence is the only signal. A
    // prior 'deleted' tombstone reappearing is a fresh creation; anything
    // else is left exactly as it already was (never downgraded away from
    // a still-pending created/modified state just because it still exists).
    if (cacheEntry.state === "deleted") {
      stats.created++;
      logger.debug({ path: fsEntry.path }, "directory recreated after deletion");
      return {
        path: fsEntry.path,
        type: "dir",
        mtime: newMtime,
        hash: null,
        state: "created",
        parent_state_version: lastSyncedVersion,
      };
    }
    stats.unchanged++;
    return null;
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
    return null;
  }

  const { hash: newHash } = await resolveFileContent(fsEntry, root, objectsRepo, logger);

  if (newHash === cacheEntry.hash) {
    // mtime noise only (e.g. a bare touch, or a cleaned-up dangling stub
    // that referenced the same content) -- refresh the baseline mtime, no
    // real content change, so don't disturb whatever state it already had
    stats.unchanged++;
    return { ...cacheEntry, mtime: newMtime };
  }

  logger.debug({ path: fsEntry.path, oldHash: cacheEntry.hash, newHash }, "file content changed");

  if (cacheEntry.state === "unchanged" || cacheEntry.state === "deleted") {
    // establishing a brand-new pending change: fresh baseline
    const newState = cacheEntry.state === "deleted" ? "created" : "modified";
    stats[newState]++;
    return {
      path: fsEntry.path,
      type: "file",
      mtime: newMtime,
      hash: newHash,
      state: newState,
      parent_state_version: lastSyncedVersion,
    };
  }

  // already pending (created/modified): content changed again before
  // syncing -- keep the original baseline, just refresh hash/mtime
  stats[cacheEntry.state]++;
  return { ...cacheEntry, mtime: newMtime, hash: newHash };
}
