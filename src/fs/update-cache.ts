import path from "node:path";
import type { Logger } from "../logger.js";
import { walk, type WalkEntry } from "./walker.js";
import { hashFile } from "./hash-file.js";
import {
  CacheEntriesRepository,
  type CacheEntryRow,
} from "../db/repositories/cache-entries-repository.js";

export interface UpdateCacheStats {
  created: number;
  modified: number;
  deleted: number;
  unchanged: number;
}

/**
 * Streaming merge-join between the sorted filesystem walk and cache.db's
 * sorted entries — advances both sides in lockstep by comparing paths,
 * never loading the full dataset into memory. See docs/architecture/
 * cache-and-filesystem-scanning.md for the full state-machine writeup.
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
  cacheRepo: CacheEntriesRepository,
  lastSyncedVersion: string,
  logger: Logger,
  onProgress?: (scanned: number) => void,
): Promise<UpdateCacheStats> {
  const stats: UpdateCacheStats = { created: 0, modified: 0, deleted: 0, unchanged: 0 };
  const pendingWrites: CacheEntryRow[] = [];

  const fsIter = walk(root);
  const cacheIter = cacheRepo.iterateAllSortedByPath();

  let fsNext = await fsIter.next();
  let cacheNext = cacheIter.next();
  let scanned = 0;

  while (!fsNext.done || !cacheNext.done) {
    const fsEntry = fsNext.done ? null : fsNext.value;
    const cacheEntry = cacheNext.done ? null : cacheNext.value;

    if (fsEntry !== null && (cacheEntry === null || fsEntry.path < cacheEntry.path)) {
      pendingWrites.push(await buildCreatedRow(fsEntry, root, lastSyncedVersion, stats, logger));
      fsNext = await fsIter.next();
    } else if (cacheEntry !== null && (fsEntry === null || cacheEntry.path < fsEntry.path)) {
      const row = buildMissingFromFsRow(cacheEntry, lastSyncedVersion, stats, logger);
      if (row) pendingWrites.push(row);
      cacheNext = cacheIter.next();
    } else if (fsEntry !== null && cacheEntry !== null) {
      const row = await buildExistingRow(
        fsEntry,
        cacheEntry,
        root,
        lastSyncedVersion,
        stats,
        logger,
      );
      if (row) pendingWrites.push(row);
      fsNext = await fsIter.next();
      cacheNext = cacheIter.next();
    }

    scanned++;
    onProgress?.(scanned);
  }

  for (const row of pendingWrites) {
    cacheRepo.upsert(row);
  }

  return stats;
}

async function buildCreatedRow(
  fsEntry: WalkEntry,
  root: string,
  lastSyncedVersion: string,
  stats: UpdateCacheStats,
  logger: Logger,
): Promise<CacheEntryRow> {
  const hash = fsEntry.type === "file" ? await hashFile(path.join(root, fsEntry.path)) : null;
  stats.created++;
  logger.debug({ path: fsEntry.path, type: fsEntry.type }, "new path detected");
  return {
    path: fsEntry.path,
    type: fsEntry.type,
    mtime: Math.round(fsEntry.mtimeMs),
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

  // Files: only rehash when mtime actually differs, so an untouched
  // multi-GB video never gets re-read on every scan.
  if (cacheEntry.mtime === newMtime) {
    stats.unchanged++;
    return null;
  }

  const newHash = await hashFile(path.join(root, fsEntry.path));

  if (newHash === cacheEntry.hash) {
    // mtime noise only (e.g. a bare touch) -- refresh the baseline mtime,
    // no real content change, so don't disturb whatever state it already had
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
