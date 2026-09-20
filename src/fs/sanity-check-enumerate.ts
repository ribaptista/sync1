import type { EntriesRepository } from "../db/repositories/entries-repository.js";
import type { Logger } from "../logger.js";
import type { ProgressTracker } from "../progress-types.js";
import { walk } from "./walker.js";
import { matchesAnyGlob } from "./glob-match.js";
import type { EnumerationControl } from "./update-cache-enumerate.js";

/**
 * How many merge-join steps between published estimates. Same figure and
 * same reasoning as update-cache-enumerate.ts's own constant.
 */
const PUBLISH_EVERY_ROWS = 512;

/**
 * Counts what `performSanityCheck` is about to hash, so the bar has a real
 * denominator early instead of one that climbs until the run ends.
 *
 * Same shape and rationale as `enumerateUpdateCacheWork`, over the same
 * two sorted sequences sanity_check itself merge-joins -- the filesystem
 * walk and `entries` -- except that here the tracked side is state.db
 * rather than cache.db. Only a path present on *both* sides, in `--filter`
 * scope, tracked as a file, and materialized as a real file costs bytes:
 * a stub answers from its own declared hash (a cheap synchronous read), a
 * directory has no content, and everything else is reported without being
 * read at all.
 *
 * Deliberately not checked here: `representation === "both"` (a stray stub
 * alongside the real file), which the real pass reports without hashing.
 * The walker already distinguishes it, so it costs nothing to honour, and
 * it keeps the estimate from claiming bytes for a path that will never be
 * read.
 *
 * Advisory in the strongest sense: it never throws, never mutates, and its
 * numbers are only ever a floor-raising estimate that `settle()` discards
 * at the end.
 */
export async function enumerateSanityCheckWork(
  root: string,
  entriesRepo: EntriesRepository,
  filterGlob: string | undefined,
  progress: ProgressTracker,
  logger: Logger,
  control: EnumerationControl,
): Promise<void> {
  const inScope = (p: string): boolean =>
    filterGlob === undefined || matchesAnyGlob(p, [filterGlob]).matched;

  let files = 0;
  let bytes = 0;
  let sincePublish = 0;

  try {
    // A second iterator over the same connection is safe: keyset
    // pagination runs each page as one `.all()` that drains within a
    // single synchronous turn, so neither scan ever leaves a cursor
    // paused -- the only thing better-sqlite3 actually forbids here
    // (docs/architecture/concurrency-and-progress.md).
    const fsIter = walk(root);
    const entryIter = entriesRepo.iterateAllSortedByPath();

    let fsNext = await fsIter.next();
    let entryNext = entryIter.next();

    while (!fsNext.done || !entryNext.done) {
      if (control.stop) return;

      const fsEntry = fsNext.done ? null : fsNext.value;
      const entry = entryNext.done ? null : entryNext.value;

      // One per merge-join step, matching the real pass's rowDiscovered().
      files++;

      if (fsEntry !== null && (entry === null || fsEntry.path < entry.path)) {
        // Filesystem-only: untracked or ignored. Reported, never read.
        fsNext = await fsIter.next();
      } else if (entry !== null && (fsEntry === null || entry.path < fsEntry.path)) {
        // Tracked but missing locally. Nothing on disk to hash.
        entryNext = entryIter.next();
      } else if (fsEntry !== null && entry !== null) {
        if (inScope(entry.path) && entry.type !== "dir" && fsEntry.representation === "real") {
          bytes += fsEntry.size;
        }
        fsNext = await fsIter.next();
        entryNext = entryIter.next();
      }

      if (++sincePublish >= PUBLISH_EVERY_ROWS) {
        sincePublish = 0;
        progress.setEstimatedTotals({ files, bytes });
      }
    }

    progress.setEstimatedTotals({ files, bytes });
  } catch (err) {
    // Swallowed on purpose. This pass exists to make a progress bar
    // useful; it must never be the reason a sanity_check fails. The run
    // continues with exactly the incrementally-discovered totals it had
    // before this pass existed.
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "progress enumeration failed -- continuing without an estimated total",
    );
  }
}
