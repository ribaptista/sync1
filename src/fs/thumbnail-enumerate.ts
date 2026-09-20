import type { Logger } from "../logger.js";
import { walk } from "./walker.js";
import type { EnumerationControl } from "./update-cache-enumerate.js";

/**
 * How many walked entries between published estimates. Same figure and
 * same reasoning as update-cache-enumerate.ts's own constant.
 */
const PUBLISH_EVERY_ROWS = 512;

/**
 * Counts the entries `scanThumbnails`'s walk is about to visit, so its bar
 * has a real denominator instead of one that is, by construction, always
 * equal to the numerator.
 *
 * The scan bar's unit is "files scanned", and its count used to be its own
 * total -- a bar pinned at 100% for the whole run, informative only as a
 * ticking counter. The real walk can't do better on its own: it dispatches
 * a media probe per candidate and blocks on `waitForRoom` once the pool is
 * full, so it advances no faster than probing finishes. This walk probes
 * nothing, matches nothing, and reads no cache rows -- it only counts, and
 * so runs at the speed of the filesystem.
 *
 * Deliberately counts *every* entry, directories included, rather than
 * just the thumbnail candidates: it has to match what the real walk
 * reports as its numerator (`scanned`, incremented once per entry before
 * any filtering), and a denominator counting something narrower than the
 * numerator is worse than no denominator at all.
 *
 * Advisory in the strongest sense: it never throws, never mutates, and the
 * real walk's own count is what's finally published at the end.
 */
export async function enumerateThumbnailScan(
  walkRoot: string,
  onTotal: ((total: number, final: boolean) => void) | undefined,
  logger: Logger,
  control: EnumerationControl,
): Promise<void> {
  if (!onTotal) return;

  let entries = 0;
  let sincePublish = 0;

  try {
    for await (const _entry of walk(walkRoot)) {
      if (control.stop) return;
      entries++;
      if (++sincePublish >= PUBLISH_EVERY_ROWS) {
        sincePublish = 0;
        onTotal(entries, false);
      }
    }
    onTotal(entries, false);
  } catch (err) {
    // Swallowed on purpose. This pass exists to make a progress bar
    // useful; it must never be the reason a thumbnail run fails. The run
    // continues with exactly the incrementally-discovered total it had
    // before this pass existed.
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "progress enumeration failed -- continuing without an estimated total",
    );
  }
}
