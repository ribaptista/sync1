import fs from "node:fs";
import pino from "pino";
import { MultiBar, Presets, type SingleBar } from "cli-progress";
import prettyBytes from "pretty-bytes";
import { createLogger, type Logger } from "../logger.js";

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
 */
export interface BytesProgressSession {
  setOverallTotals(totals: { files?: number; bytes?: number }): void;
  setOverallProgress(current: { files?: number; bytes?: number }): void;
  stop(): void;
}

class NullBytesProgressSession implements BytesProgressSession {
  setOverallTotals(): void {}
  setOverallProgress(): void {}
  stop(): void {}
}

class MultiBarBytesProgressSession implements BytesProgressSession {
  private readonly multibar: MultiBar;
  private readonly overall: SingleBar;
  private filesTotal = 0;
  private filesDone = 0;
  private bytesTotal = 0;
  private bytesDone = 0;

  constructor(overallLabel: string) {
    this.multibar = new MultiBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        format: `${overallLabel} |{bar}| {filesDone}/{filesTotal} files, {sizeDone}/{sizeTotal} -- ETA {eta_formatted}`,
      },
      Presets.shades_classic,
    );
    // Seeded to 1 (never 0) to avoid a divide-by-zero before the first real
    // total arrives -- same trick the plain item-count bar above uses.
    this.overall = this.multibar.create(1, 0);
    this.render();
  }

  private render(): void {
    this.overall.setTotal(Math.max(this.bytesTotal, 1));
    this.overall.update(this.bytesDone, {
      filesDone: String(this.filesDone),
      filesTotal: String(this.filesTotal),
      sizeDone: prettyBytes(this.bytesDone),
      sizeTotal: prettyBytes(this.bytesTotal),
    });
  }

  setOverallTotals(totals: { files?: number; bytes?: number }): void {
    if (totals.files !== undefined && totals.files > this.filesTotal) {
      this.filesTotal = totals.files;
    }
    if (totals.bytes !== undefined && totals.bytes > this.bytesTotal) {
      this.bytesTotal = totals.bytes;
    }
    this.render();
  }

  setOverallProgress(current: { files?: number; bytes?: number }): void {
    if (current.files !== undefined) this.filesDone = current.files;
    if (current.bytes !== undefined) this.bytesDone = current.bytes;
    this.render();
  }

  stop(): void {
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
