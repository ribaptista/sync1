import type { CacheEntryRow } from "../db/repositories/cache-entries-repository.js";
import type { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import type { Logger } from "../logger.js";
import type { ProgressTracker } from "../progress-types.js";
import { walk, type WalkEntry } from "./walker.js";
import { matchesAnyGlob } from "./glob-match.js";

/**
 * How many merge-join steps between published estimates. Publishing per
 * row would emit an update for every entry in the tree purely to move a
 * number nobody can read changing that fast; 512 keeps the denominator
 * visibly converging without adding a second flood to the one
 * FLUSH_INTERVAL_MS already exists to damp.
 */
const PUBLISH_EVERY_ROWS = 512;

/** Lets the owning run cut a still-running enumeration short -- see `enumerateUpdateCacheWork`. */
export interface EnumerationControl {
  stop: boolean;
}

/**
 * Would `performUpdateCache` hash this file's contents?
 *
 * Deliberately a pure predicate over what the walker's own `stat()`
 * already produced plus the cache row's recorded mtime -- no stub reads,
 * no `objects` lookups, no filesystem writes. It mirrors the real pass's
 * decisions (`classifyContent` and `dispatchExistingRow` in
 * update-cache.ts) closely enough to get the byte total right, and is
 * allowed to be wrong: every consequence of being wrong is absorbed by
 * `max(observed, estimated)` and `settle()`.
 *
 * - A directory has no content.
 * - A stub resolves from the hash it declares about itself, never by
 *   hashing anything, however stale its mtime looks.
 * - `both` (a stray stub alongside the real file) is always re-resolved,
 *   mtime notwithstanding, because the real file wins and the stub is
 *   cleaned up.
 * - A path the filesystem has but cache.db doesn't is new, so its content
 *   has never been hashed.
 * - Otherwise it comes down to the same mtime comparison the real pass
 *   makes, which is what stops an untouched multi-GB video being re-read
 *   on every scan.
 */
function needsHash(fsEntry: WalkEntry, cacheEntry: CacheEntryRow | null): boolean {
  if (fsEntry.type !== "file") return false;
  if (fsEntry.representation === "stub") return false;
  if (cacheEntry === null) return true;
  if (fsEntry.representation === "both") return true;
  return cacheEntry.mtime !== Math.round(fsEntry.mtimeMs);
}

/**
 * Counts what `performUpdateCache` is about to do, so the progress bar has
 * a real denominator early instead of one that climbs until the run ends.
 *
 * This exists because the real pass can only discover its own total as
 * fast as it can *finish* the work: its producer loop blocks on
 * `hashJobs.dispatch()` once the hash pool is full, so on a tree with real
 * changes the totals were still climbing at the moment the last file
 * finished hashing. This pass does the same merge-join and the same
 * classification, dispatches nothing, and therefore runs at the speed of
 * the filesystem rather than the speed of hashing.
 *
 * Run it *concurrently* with the real pass, not before it: on an unchanged
 * tree the walk is the entire cost of update_cache, so a sequential
 * pre-pass would roughly double the runtime of by far the most common case
 * -- a no-op `sync` -- in exchange for a bar nobody is watching. Run
 * alongside, its cost is overlapped, and it warms the dentry cache for the
 * walk following behind it.
 *
 * Advisory in the strongest sense: it never throws (a failure just means
 * the run proceeds with the denominator it would have had anyway), never
 * mutates anything, and its numbers are only ever a floor-raising estimate
 * that `settle()` discards at the end.
 */
export async function enumerateUpdateCacheWork(
  root: string,
  cacheRepo: CacheEntriesRepository,
  ignoreGlobs: readonly string[],
  progress: ProgressTracker,
  logger: Logger,
  control: EnumerationControl,
): Promise<void> {
  let files = 0;
  let bytes = 0;
  let sincePublish = 0;

  try {
    // A second iterator over the same connection is safe: keyset
    // pagination runs each page as one `.all()` that drains within a
    // single synchronous turn, so neither scan ever leaves a cursor
    // paused -- which is the only thing better-sqlite3 actually forbids
    // here (docs/architecture/concurrency-and-progress.md).
    const fsIter = walk(root);
    const cacheIter = cacheRepo.iterateAllSortedByPath();

    let fsNext = await fsIter.next();
    let cacheNext = cacheIter.next();

    while (!fsNext.done || !cacheNext.done) {
      if (control.stop) return;

      const fsEntry = fsNext.done ? null : fsNext.value;
      const cacheEntry = cacheNext.done ? null : cacheNext.value;

      // One per merge-join step, matching the real pass's rowDiscovered().
      files++;

      if (fsEntry !== null && (cacheEntry === null || fsEntry.path < cacheEntry.path)) {
        // Filesystem-only: a new path. Ignored paths never reach content
        // classification at all, so they cost nothing.
        if (!matchesAnyGlob(fsEntry.path, ignoreGlobs).matched && needsHash(fsEntry, null)) {
          bytes += fsEntry.size;
        }
        fsNext = await fsIter.next();
      } else if (cacheEntry !== null && (fsEntry === null || cacheEntry.path < fsEntry.path)) {
        // cache.db-only: a deletion. Nothing left on disk to hash.
        cacheNext = cacheIter.next();
      } else if (fsEntry !== null && cacheEntry !== null) {
        // Both sides. No ignore check here, mirroring the real pass: an
        // already-tracked path isn't retroactively un-tracked by a policy.
        if (needsHash(fsEntry, cacheEntry)) bytes += fsEntry.size;
        fsNext = await fsIter.next();
        cacheNext = cacheIter.next();
      }

      if (++sincePublish >= PUBLISH_EVERY_ROWS) {
        sincePublish = 0;
        progress.setEstimatedTotals({ files, bytes });
      }
    }

    progress.setEstimatedTotals({ files, bytes });
  } catch (err) {
    // Swallowed on purpose. This pass exists to make a progress bar
    // useful; it must never be the reason a scan fails. The run continues
    // with exactly the incrementally-discovered totals it had before this
    // pass existed.
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "progress enumeration failed -- continuing without an estimated total",
    );
  }
}
