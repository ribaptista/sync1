import fs from "node:fs";
import pino from "pino";
import { MultiBar, Presets, type SingleBar } from "cli-progress";
import prettyBytes from "pretty-bytes";
import { createLogger, type Logger } from "../logger.js";
import type { OnProgress, ProgressUpdate } from "../progress-types.js";

export interface ShouldShowProgressOptions {
  json: boolean;
  progress: boolean;
}

/** false for --json or --no-progress; otherwise only when stderr is a real terminal. */
export function shouldShowProgress(opts: ShouldShowProgressOptions): boolean {
  if (opts.json || !opts.progress) return false;
  return process.stderr.isTTY === true;
}

export interface ProgressSession {
  setOverallTotal(total: number): void;
  advanceOverall(n?: number): void;
  stop(): void;
}

class NullProgressSession implements ProgressSession {
  setOverallTotal(): void {}
  advanceOverall(): void {}
  stop(): void {}
}

class MultiBarProgressSession implements ProgressSession {
  private readonly multibar: MultiBar;
  private readonly overall: SingleBar;
  private overallValue = 0;

  constructor(overallLabel: string, overallUnit: string) {
    this.multibar = new MultiBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        format: `${overallLabel} |{bar}| {value}/{total} ${overallUnit}`,
      },
      Presets.shades_classic,
    );
    this.overall = this.multibar.create(1, 0);
  }

  setOverallTotal(total: number): void {
    if (total > this.overall.getTotal()) this.overall.setTotal(total);
  }

  advanceOverall(n = 1): void {
    this.overallValue += n;
    this.overall.update(this.overallValue);
  }

  stop(): void {
    this.multibar.stop();
  }
}

export function startProgressSession(opts: {
  show: boolean;
  overallLabel: string;
  overallUnit: string;
}): ProgressSession {
  return opts.show
    ? new MultiBarProgressSession(opts.overallLabel, opts.overallUnit)
    : new NullProgressSession();
}

/**
 * The byte-aware counterpart to `ProgressSession`, for the commands that
 * actually hash/upload/download file content (update_cache, sync,
 * materialize, stubify, sanity_check -- see docs/architecture/concurrency-
 * and-progress.md). A single bar shows both file counts and byte totals,
 * but only bytes ever drive the bar's own internal total/current -- and
 * therefore `{eta_formatted}`'s real math -- since an ETA derived from item
 * *count* alone would be misleading when file sizes vary wildly (hashing
 * one 4GB video vs. ten 1KB text files). File counts ride along purely as
 * custom payload tokens, cosmetic only.
 *
 * Both totals and progress values are only ever set as an absolute number,
 * not a delta -- `setOverallTotals` only grows a total, exactly like
 * `ProgressSession.setOverallTotal`; `setOverallProgress` sets the current
 * position directly (mirroring `SingleBar.update(value)`'s own primitive),
 * so no delta bookkeeping is needed by any caller.
 *
 * `setOverallProgress`'s `activity` is the trailing per-file label
 * (`hashing …/summer/IMG_0431.jpg...`) -- rendered verbatim, this module
 * has no vocabulary of its own for what "hashing" or "uploading" mean, see
 * `fitPath` and `reporterFor` below. Like `files`/`bytes`, omitting it
 * leaves whatever was last shown in place rather than clearing it; a
 * caller that wants a clean label at a phase boundary (so a stale
 * `uploaded …` doesn't survive into a download phase, say) gets that for
 * free by building a fresh `ProgressTracker` per phase rather than by this
 * session clearing anything itself.
 */
export interface BytesProgressSession {
  setOverallTotals(totals: { files?: number; bytes?: number }): void;
  setOverallProgress(current: {
    files?: number;
    bytes?: number;
    activity?: { verb: string; path: string } | undefined;
  }): void;
  stop(): void;
}

class NullBytesProgressSession implements BytesProgressSession {
  setOverallTotals(): void {}
  setOverallProgress(): void {}
  stop(): void {}
}

// Rough width of everything on the byte-progress line other than the
// activity label itself: the overall label, the bar (cli-progress's own
// default barsize is 40 columns), the surrounding "|...|" decoration, the
// file counts, the pretty-printed byte sizes, and the ETA. Deliberately
// approximate -- digit counts and the overall label's own length shift the
// real figure by a handful of characters as a run progresses -- because
// `linewrap: false` (see fitPath below) makes this cosmetic only: getting
// it slightly wrong just clips a couple more/fewer characters, never
// corrupts the line.
const ACTIVITY_LABEL_CHROME = 55;

// Leading mark on a path that had to be truncated to fit -- one character,
// so the floor case in fitPath (budget too small for anything else) still
// has somewhere valid to go.
const TRUNCATION_MARK = "…";

/**
 * Truncates `path` to fit the terminal width, keeping the *tail*.
 * `linewrap: false` makes cli-progress write each line raw and let the
 * terminal clip whatever overflows at the right edge -- fine for the rest
 * of the line, but wrong for a path, where the filename at the tail (not
 * the leading directories) is the informative half; this function does the
 * truncation ourselves so the tail always survives instead.
 *
 * Mirrors cli-progress's own width fallback exactly (`stream.columns ||
 * 80`) so this stays in sync with the bar's own behavior on a
 * non-TTY-but-still-columns-reporting stream, and is called fresh on every
 * render rather than once at construction so a terminal resize is picked
 * up. `verb` factors into the budget because the two verbs sharing a
 * phase's line differ in width (`hashing` vs. `downloading`); no padding
 * is applied for the difference since the label is last on the line, so a
 * variable width shifts nothing that comes before it.
 */
export function fitPath(path: string, columns: number | undefined, verb: string): string {
  const width = columns || 80;
  const budget = Math.max(width - ACTIVITY_LABEL_CHROME - verb.length, TRUNCATION_MARK.length);
  if (path.length <= budget) return path;
  return TRUNCATION_MARK + path.slice(path.length - (budget - TRUNCATION_MARK.length));
}

class MultiBarBytesProgressSession implements BytesProgressSession {
  private readonly multibar: MultiBar;
  private readonly overall: SingleBar;
  private filesTotal = 0;
  private filesDone = 0;
  private bytesTotal = 0;
  private bytesDone = 0;
  private activity: { verb: string; path: string } | undefined;

  // How often our state is actually pushed into the underlying bar -- and
  // therefore into cli-progress's own ETA ring buffer (a fixed 10-sample
  // window, node_modules/cli-progress/lib/eta.js). Matched to cli-progress's
  // own `fps: 10` redraw rate, so this never slows down what's visible:
  // MultiBar repaints every bar off its own independent ~100ms timer
  // regardless of how often we call `.update()` (multi-bar.js), so pushing
  // state in faster than that buys nothing on screen while still feeding
  // that 10-sample buffer far faster than a representative rate needs --
  // which is exactly what produced a nonsense ETA (`NFs`, or `0s` with tens
  // of GB still left): dozens of file-discovery/-resolution events plus
  // every in-flight hash's 100ms byte-counter poll (see hash-runner.ts) can
  // otherwise flood all 10 samples within a handful of milliseconds, so the
  // "recent rate" computed over that sliver is essentially noise.
  private static readonly FLUSH_INTERVAL_MS = 100;
  // `null`, not `0`, so "never flushed yet" can't be confused with "flushed
  // at Date.now() === 0" (a frozen/fake clock in a test, say).
  private lastFlushedAt: number | null = null;

  constructor(overallLabel: string) {
    this.multibar = new MultiBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        format: `${overallLabel} |{bar}| {filesDone}/{filesTotal} files, {sizeDone}/{sizeTotal} -- ETA {eta_formatted} {activity}`,
      },
      Presets.shades_classic,
    );
    // Seeded to 1 (never 0) to avoid a divide-by-zero before the first real
    // total arrives -- same trick the plain item-count bar above uses.
    this.overall = this.multibar.create(1, 0);
    this.flush(true);
  }

  // Built fresh on every flush, not cached: `fitPath` reads
  // `process.stderr.columns` at call time specifically so a terminal
  // resize between renders is picked up, which a value computed once here
  // and reused would defeat.
  private activityLabel(): string {
    if (!this.activity) return "";
    const { verb, path } = this.activity;
    return `${verb} ${fitPath(path, process.stderr.columns, verb)}...`;
  }

  /**
   * Pushes the session's current state into the underlying bar -- the only
   * thing that feeds cli-progress's own ETA sample buffer, see
   * `FLUSH_INTERVAL_MS` above. `setTotal` always runs (cheap, and doesn't
   * touch the eta buffer itself -- only `.update()`'s *value* does); the
   * `.update()` call itself is what's throttled, unless `force` is set for
   * one of three cases that must never wait out the window: the very first
   * flush (so the bar isn't blank, and so a cold-start activity label
   * reaches it instantly), any update carrying a new `activity` (rare by
   * construction -- at most two per file, start and finish -- so bypassing
   * them costs nothing toward the flood this exists to suppress, and a user
   * watching the label for proof-of-life shouldn't wait on it), and
   * `stop()`'s final flush (`MultiBar.stop()` re-renders each bar's
   * *current* value one last time with `clearOnComplete: false`, so a
   * throttled-away update must land before that happens, or the run could
   * end on a stale mid-throttle snapshot).
   */
  private flush(force: boolean): void {
    this.overall.setTotal(Math.max(this.bytesTotal, 1));
    const now = Date.now();
    if (
      !force &&
      this.lastFlushedAt !== null &&
      now - this.lastFlushedAt < MultiBarBytesProgressSession.FLUSH_INTERVAL_MS
    ) {
      return;
    }
    this.lastFlushedAt = now;
    this.overall.update(this.bytesDone, {
      filesDone: String(this.filesDone),
      filesTotal: String(this.filesTotal),
      sizeDone: prettyBytes(this.bytesDone),
      sizeTotal: prettyBytes(this.bytesTotal),
      activity: this.activityLabel(),
    });
  }

  setOverallTotals(totals: { files?: number; bytes?: number }): void {
    if (totals.files !== undefined && totals.files > this.filesTotal) {
      this.filesTotal = totals.files;
    }
    if (totals.bytes !== undefined && totals.bytes > this.bytesTotal) {
      this.bytesTotal = totals.bytes;
    }
    this.flush(false);
  }

  setOverallProgress(current: {
    files?: number;
    bytes?: number;
    activity?: { verb: string; path: string } | undefined;
  }): void {
    if (current.files !== undefined) this.filesDone = current.files;
    if (current.bytes !== undefined) this.bytesDone = current.bytes;
    const isNewActivity = current.activity !== undefined;
    if (isNewActivity) this.activity = current.activity;
    this.flush(isNewActivity);
  }

  stop(): void {
    this.flush(true);
    this.multibar.stop();
  }
}

export function startBytesProgressSession(opts: {
  show: boolean;
  overallLabel: string;
}): BytesProgressSession {
  return opts.show
    ? new MultiBarBytesProgressSession(opts.overallLabel)
    : new NullBytesProgressSession();
}

/**
 * Adapts a `BytesProgressSession` into the `OnProgress` callback a
 * `ProgressTracker` (see `../progress-types.js`) calls with each update --
 * collapsing the setOverallTotals/setOverallProgress two-line dance that
 * used to be hand-duplicated once per command (update_cache, sync,
 * materialize, stubify, sanity_check) into a single call each command
 * makes when it builds its tracker.
 */
export function reporterFor(session: BytesProgressSession): OnProgress {
  return (update: ProgressUpdate) => {
    session.setOverallTotals({ files: update.filesTotal, bytes: update.bytesTotal });
    session.setOverallProgress({
      files: update.filesDone,
      bytes: update.bytesDone,
      activity: update.activity,
    });
  };
}

let notifiedFd3Missing = false;

function fd3IsOpen(): boolean {
  try {
    fs.fstatSync(3);
    return true;
  } catch {
    return false;
  }
}

/**
 * While progress bars are rendering, they own stderr exclusively -- verbose
 * logging (if requested) is diverted to file descriptor 3 instead, which is
 * only ever open if the *caller* redirected it there (e.g. `3>/tmp/x.log`).
 * This function never opens a file itself. If fd 3 isn't open, verbose
 * output is silently discarded (after a one-time notice) rather than
 * corrupting the bars.
 */
export function createLoggerForRun(opts: { verbose: boolean; showProgress: boolean }): Logger {
  if (!opts.showProgress) {
    return createLogger(opts.verbose);
  }
  if (fd3IsOpen()) {
    return createLogger(opts.verbose, pino.destination({ fd: 3, sync: false }));
  }
  if (opts.verbose && !notifiedFd3Missing) {
    notifiedFd3Missing = true;
    process.stderr.write(
      "note: --verbose output is being discarded while progress bars are active -- redirect fd 3 (e.g. `3>/tmp/sync1.log`) to capture it\n",
    );
  }
  const discard: pino.DestinationStream = { write: () => true };
  return createLogger(false, discard);
}
