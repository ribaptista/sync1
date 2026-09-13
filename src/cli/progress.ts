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

export interface ChildBar {
  advanceBytes(n: number): void;
  done(): void;
}

export interface ProgressSession {
  setOverallTotal(total: number): void;
  advanceOverall(n?: number): void;
  addChildBar(label: string, totalBytes: number): ChildBar;
  stop(): void;
}

class NullChildBar implements ChildBar {
  advanceBytes(): void {}
  done(): void {}
}

class NullProgressSession implements ProgressSession {
  setOverallTotal(): void {}
  advanceOverall(): void {}
  addChildBar(): ChildBar {
    return new NullChildBar();
  }
  stop(): void {}
}

class MultiBarChildBar implements ChildBar {
  private bytes = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly multibar: MultiBar,
    private readonly bar: SingleBar,
  ) {}

  advanceBytes(n: number): void {
    this.bytes += n;
    const elapsedSeconds = Math.max((Date.now() - this.startedAt) / 1000, 0.001);
    const rate = `${prettyBytes(this.bytes / elapsedSeconds)}/s`;
    this.bar.update(this.bytes, { rate });
  }

  done(): void {
    this.multibar.remove(this.bar);
  }
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

  addChildBar(label: string, totalBytes: number): ChildBar {
    const bar = this.multibar.create(Math.max(totalBytes, 1), 0, undefined, {
      format: `  ${label} |{bar}| {value}/{total} bytes {rate}`,
    });
    bar.update(0, { rate: "" });
    return new MultiBarChildBar(this.multibar, bar);
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
