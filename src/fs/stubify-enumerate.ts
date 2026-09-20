import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import type { Logger } from "../logger.js";
import type { ProgressTracker } from "../progress-types.js";
import type { EnumerationControl } from "./update-cache-enumerate.js";
import { isUnderThumbnailDir } from "./thumbnail.js";

/**
 * How many scanned rows between published estimates -- and, since this
 * scan is otherwise entirely synchronous, also how often it yields the
 * event loop back to the hashing it's running alongside. Same figure and
 * same reasoning as update-cache-enumerate.ts's own constant.
 */
const PUBLISH_EVERY_ROWS = 512;

/**
 * Counts what `stubifyGlob` is about to do, so the bar has a real
 * denominator early instead of one that climbs until the run ends.
 *
 * Same shape and same rationale as `enumerateUpdateCacheWork`: the real
 * pass's producer loop blocks on `hashJobs.dispatch()` once the hash pool
 * is full, so its totals were still climbing as the last file finished
 * hashing. This pass makes the same decisions with nothing but `stat`,
 * dispatches nothing, and so runs at the speed of the filesystem's
 * metadata rather than the speed of hashing.
 *
 * Unlike update_cache's walk, every step here is synchronous (a keyset
 * page, then `existsSync`/`statSync` per row), so "concurrent" has to be
 * made true rather than assumed: the loop hands the event loop back every
 * `PUBLISH_EVERY_ROWS` rows, which is what keeps already-dispatched
 * rehashes progressing while this counts.
 *
 * Advisory in the strongest sense: it never throws, never mutates, and
 * its numbers are only ever a floor-raising estimate that `settle()`
 * discards at the end.
 */
export async function enumerateStubifyWork(
  root: string,
  glob: string,
  cacheRepo: CacheEntriesRepository,
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
    // paused -- the only thing better-sqlite3 actually forbids here
    // (docs/architecture/concurrency-and-progress.md).
    for (const row of cacheRepo.iterateByGlobSortedByPath(glob)) {
      if (control.stop) return;

      // One per glob-matched row, matching the real pass's
      // rowDiscovered() -- including the directory and thumbnail rows it
      // resolves without touching, which are files the run is still
      // responsible for accounting for.
      files++;

      // Everything below mirrors processRow's own exits, in its order:
      // only a row that reaches the rehash dispatch is worth bytes. A row
      // already stubbed, not fully committed, or whose mtime still
      // matches resolves without reading a single byte of content.
      if (
        row.type === "file" &&
        row.state === "unchanged" &&
        !isUnderThumbnailDir(row.path) &&
        row.size !== null
      ) {
        const absolutePath = path.join(root, row.path);
        // statSync rather than existsSync-then-statSync: one syscall
        // instead of two, and a missing file (already a stub) throws
        // exactly where existsSync would have returned false.
        let currentMtime: number | null = null;
        try {
          currentMtime = Math.round(fs.statSync(absolutePath).mtimeMs);
        } catch {
          currentMtime = null;
        }
        if (currentMtime !== null && currentMtime !== row.mtime) bytes += row.size;
      }

      if (++sincePublish >= PUBLISH_EVERY_ROWS) {
        sincePublish = 0;
        progress.setEstimatedTotals({ files, bytes });
        await yieldToEventLoop();
      }
    }

    progress.setEstimatedTotals({ files, bytes });
  } catch (err) {
    // Swallowed on purpose. This pass exists to make a progress bar
    // useful; it must never be the reason a stubify fails. The run
    // continues with exactly the incrementally-discovered totals it had
    // before this pass existed.
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "progress enumeration failed -- continuing without an estimated total",
    );
  }
}
