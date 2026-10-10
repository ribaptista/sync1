import fs from "node:fs";
import pino from "pino";
// Default import, not named -- `Format` is a nested object literal inside
// cli-progress's single `module.exports = {...}` (node_modules/
// cli-progress/cli-progress.js), and cjs-module-lexer (which both Node's
// own ESM/CJS interop and Vite/Vitest's module graph use to detect named
// exports from a CommonJS package) only recognizes a property whose value
// is a plain identifier -- MultiBar/Presets/Bar/SingleBar qualify, Format
// doesn't. `import { Format } from "cli-progress"` compiles and typechecks
// (the .d.ts declares it as a named export) but throws at runtime with
// "does not provide an export named 'Format'" -- confirmed directly
// against a real `node --input-type=module` run, not assumed from the
// types. The default export is the same object either way, so
// destructuring off it sidesteps the detection gap entirely.
import cliProgress, { type SingleBar, type MultiBar } from "cli-progress";
// `MultiBar` above is a type-only import (a plain identifier, so
// cjs-module-lexer detects it fine as a value too -- but destructuring the
// default export instead, uniformly with Format, keeps one clear rule:
// every runtime binding from this module comes off `cliProgress` itself.
const { MultiBar: MultiBarCtor, Presets, Format } = cliProgress;
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
  /**
   * Grows the total, or -- with `final` -- sets it outright. Grow-only is
   * the right default for a total discovered by a running scan (it only
   * ever climbs); `final` is for a total that was *counted* rather than
   * discovered, which may legitimately come in lower than a provisional
   * figure already on screen. Clamped to never land below what's already
   * done, so an over-count corrected at the end can't render past 100%.
   */
  setOverallTotal(total: number, opts?: { final?: boolean }): void;
  advanceOverall(n?: number): void;
  /**
   * Sets the current position outright, for a producer that already
   * tracks its own running tally (a pool whose jobs complete out of
   * order, say). The delta-based `advanceOverall` is the wrong primitive
   * there -- turning an absolute count back into deltas at the call site
   * is bookkeeping that exists only to be got wrong.
   */
  setOverallProgress(value: number): void;
  /**
   * The current per-item activity label (e.g. `{ verb: "generating", path:
   * "a.jpg" }`), rendered verbatim beside the bar -- the plain item-count
   * counterpart to `BytesProgressSession`'s own `activity` token (see
   * `MultiBarByteBar.activityLabel`). `undefined` clears it back to blank.
   */
  setActivity(activity: { verb: string; path: string } | undefined): void;
  stop(): void;
}

class NullProgressSession implements ProgressSession {
  setOverallTotal(): void {}
  advanceOverall(): void {}
  setOverallProgress(): void {}
  setActivity(): void {}
  stop(): void {}
}

/**
 * cli-progress's own `formatTime` has a real bug, not merely an
 * unfortunate default. When the ETA rate is structurally zero --
 * nothing has moved yet, or two updates land in the same millisecond --
 * `ETA.calculate` (node_modules/cli-progress/lib/eta.js) stores the
 * *string* sentinel `'INF'` (an `Infinity` division) or `'NULL'` (a `NaN`
 * one) rather than a number. `formatTime`'s own `t > 3600` / `t > 60` /
 * `t > 10` comparisons are all `false` against a string, so it falls
 * through to `autopadding(t) + 's'` -- string concatenation, not
 * formatting -- which renders as the literal `NFs` (from `'INF'`.slice(-2))
 * or `LLs` (from `'NULL'`.slice(-2)). The types cli-progress ships (`t:
 * number`) don't admit this at all; it's a genuine runtime/type mismatch
 * in the library, not something a `number`-typed override can be told
 * about, hence the runtime `typeof` check below despite the declared type.
 *
 * Renders both sentinels, and any other non-finite value, as `--`
 * instead; delegates to the real default formatter for every genuine
 * number, so an ordinary ETA still formats exactly as before.
 */
export function formatEtaTime(
  t: number,
  options: Parameters<typeof Format.TimeFormat>[1],
  roundToMultipleOf: number,
): string {
  // `typeof t === "string"` looks impossible against the declared `number`
  // type -- it's not, at runtime. See the doc comment above.
  if (typeof t === "string" || !Number.isFinite(t)) return "--";
  return Format.TimeFormat(t, options, roundToMultipleOf);
}

class MultiBarProgressSession implements ProgressSession {
  private readonly multibar: MultiBar;
  private readonly overall: SingleBar;
  private overallValue = 0;
  // Tracked here rather than read back off the bar so the rendered
  // `{totalLabel}` payload and the bar's own arithmetic total can't drift.
  private overallTotal = 1;
  private totalsFinal = false;
  private activity: { verb: string; path: string } | undefined;

  constructor(overallLabel: string, overallUnit: string) {
    this.multibar = new MultiBarCtor(
      {
        clearOnComplete: false,
        hideCursor: true,
        // See formatEtaTime above -- this format string doesn't render
        // {eta_formatted} today, but set globally rather than per-bar so
        // it's never a trap for a future format string that does.
        formatTime: formatEtaTime,
        // `{totalLabel}`, not cli-progress's built-in `{total}`: the total
        // needs a "~" prefix while it's still provisional, and only a
        // custom payload token can carry one.
        format: `${overallLabel} |{bar}| {value}/{totalLabel} ${overallUnit} {activity}`,
      },
      Presets.shades_classic,
    );
    // Seeded to 1 (never 0) to avoid a divide-by-zero before the first real
    // total arrives.
    this.overall = this.multibar.create(this.overallTotal, 0, {
      totalLabel: this.totalLabel(),
      activity: this.activityLabel(),
    });
  }

  private totalLabel(): string {
    return `${this.totalsFinal ? "" : "~"}${this.overallTotal}`;
  }

  // Same shape as MultiBarByteBar's own activityLabel -- see that one's
  // doc comment for why the path is truncated (kept-tail) rather than
  // left to the terminal's own line-wrap.
  private activityLabel(): string {
    if (!this.activity) return "";
    const { verb, path } = this.activity;
    return `${verb} ${fitPath(path, process.stderr.columns, verb)}...`;
  }

  setOverallTotal(total: number, opts?: { final?: boolean }): void {
    if (opts?.final === true) {
      this.totalsFinal = true;
      this.overallTotal = Math.max(total, this.overallValue);
    } else if (total > this.overallTotal) {
      this.overallTotal = total;
    }
    this.overall.setTotal(this.overallTotal);
    this.overall.update(this.overallValue, {
      totalLabel: this.totalLabel(),
      activity: this.activityLabel(),
    });
  }

  advanceOverall(n = 1): void {
    this.overallValue += n;
    this.overall.update(this.overallValue, {
      totalLabel: this.totalLabel(),
      activity: this.activityLabel(),
    });
  }

  setOverallProgress(value: number): void {
    this.overallValue = value;
    this.overall.update(this.overallValue, {
      totalLabel: this.totalLabel(),
      activity: this.activityLabel(),
    });
  }

  setActivity(activity: { verb: string; path: string } | undefined): void {
    this.activity = activity;
    this.overall.update(this.overallValue, {
      totalLabel: this.totalLabel(),
      activity: this.activityLabel(),
    });
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
export interface BytesProgressTarget {
  setOverallTotals(totals: { files?: number; bytes?: number; final?: boolean }): void;
  setOverallProgress(current: {
    files?: number;
    bytes?: number;
    activity?: { verb: string; path: string } | undefined;
    /**
     * Cumulative bytes per named destination, for the per-sink rates in
     * the bar's label. Optional throughout: every producer but sync's
     * upload phase omits it, and those bars render exactly as before.
     */
    sinkBytes?: Readonly<Record<string, number>> | undefined;
  }): void;
}

export interface BytesProgressSession extends BytesProgressTarget {
  /**
   * Mints an additional bar, labelled `label`, in this session's display.
   *
   * For a run built from sequential phases whose work isn't commensurable
   * -- `sync` hashes locally, then uploads, then downloads -- one bar per
   * phase is both simpler and more honest than summing them. A combined
   * denominator can't be known anyway (each phase operates on a set the
   * previous one produces), and a single ETA over a mixture of local
   * hashing and network transfer is partly fiction; three ETAs over
   * homogeneous work are each real.
   *
   * Call it when the phase actually begins, not up front: bars are
   * rendered from the moment they exist, and a bar sitting at 0 for a
   * phase whose inputs don't exist yet is just a lie with a progress
   * indicator attached.
   */
  startPhase(label: string): BytesProgressTarget;
  stop(): void;
}

class NullBytesProgressSession implements BytesProgressSession {
  setOverallTotals(): void {}
  setOverallProgress(): void {}
  startPhase(): BytesProgressTarget {
    return this;
  }
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

/**
 * One byte-progress bar's own state and rendering. Split out from the
 * session below so a session can host several: a single-phase command
 * has exactly one, `sync` has one per phase. Every counter here is
 * per-bar -- including the flush throttle, since two bars competing for
 * one shared throttle would each suppress the other's updates.
 */
class MultiBarByteBar implements BytesProgressTarget {
  private readonly overall: SingleBar;
  private filesTotal = 0;
  private filesDone = 0;
  private bytesTotal = 0;
  private bytesDone = 0;
  private totalsFinal = false;
  private activity: { verb: string; path: string } | undefined;

  // Whether setOverallTotals/setOverallProgress has recorded state since
  // the last time it actually reached the underlying bar. Pushing on every
  // call -- rather than batching into the next tick -- is what produced a
  // premature "0s" with tens of GB still left: dozens of file-discovery/
  // -resolution events plus every in-flight hash's 100ms byte-counter poll
  // (see hash-runner.ts) can flood cli-progress's own 10-sample ETA ring
  // buffer (node_modules/cli-progress/lib/eta.js) within a handful of
  // milliseconds, so the "recent rate" computed over that sliver is
  // essentially noise. A separate, structural bug -- not related to this
  // flag -- produced the literal string `NFs`; see `formatEtaTime` above.
  //
  // `flushIfDirty` (driven by the MultiBar's own `redraw-pre` event, see
  // `MultiBarBytesProgressSession`) is what actually lands a dirty push,
  // at most once per repaint -- matching cli-progress's own `fps: 10`
  // redraw rate exactly, since it's triggered by that same repaint rather
  // than by an independent timer. This also guarantees every update
  // eventually reaches the bar: unlike a plain time-windowed throttle, a
  // push that arrives mid-window is never simply dropped if nothing later
  // arrives to carry it -- it stays dirty until the next repaint, however
  // long that is.
  private dirty = false;
  /**
   * Weight given to the newest sample. Low enough that a brief stall
   * doesn't read as a crash, high enough that a real one shows within a
   * second or so at the 100ms flush interval.
   */
  private static readonly RATE_SMOOTHING = 0.3;
  private sinkBytes: Readonly<Record<string, number>> | undefined;
  private readonly lastSinkBytes: Record<string, number> = {};
  private readonly smoothedRates: Record<string, number> = {};
  private lastRateSampleAt: number | null = null;

  constructor(multibar: MultiBar, label: string) {
    // Seeded to 1 (never 0) to avoid a divide-by-zero before the first real
    // total arrives -- same trick the plain item-count bar above uses.
    // The format is per-bar rather than on the MultiBar, since each bar
    // carries its own label.
    this.overall = multibar.create(1, 0, undefined, {
      // `{etaPrefix}` carries the "~" for the ETA the same way
      // `{filesTotal}`/`{sizeTotal}` carry their own: cli-progress
      // computes `{eta_formatted}` internally, so the marker has to sit
      // beside it rather than inside it.
      //
      // Bytes come first, ahead of the file count: the bar's fill and its
      // ETA are both computed from bytes alone (nothing else drives
      // `.update()`'s value), so the byte pair is the bar's own legend and
      // belongs adjacent to it. With files first, an empty bar read as a
      // contradiction -- "54529/54529 files, 0 B/0 B" looks like it's
      // simultaneously done and not started. With bytes first, "0 B/0 B"
      // beside an empty bar reads as exactly what it is: nothing needed
      // transferring. Same payload keys, same values, just reordered.
      format: `${label} |{bar}| {sizeDone}/{sizeTotal}, {filesDone}/{filesTotal} files -- {etaPrefix}ETA {eta_formatted}{rates} {activity}`,
    });
    this.flush(true);
  }

  /**
   * Per-destination throughput, e.g. ` [s3 12.4 MB/s, mirror 8.1 MB/s]`.
   * Empty unless a producer reported sink bytes, so every other bar in the
   * tool renders exactly as before.
   *
   * A rate over the interval since the last flush rather than an all-run
   * average, because the question it answers is "what is happening *now*"
   * -- a mount that has just stalled should read as stalled immediately,
   * where an average would take minutes to sag. Smoothed with an EMA so a
   * single slow 100ms window doesn't make the number jitter unreadably.
   *
   * Sink *names* come from the producer (see ProgressUpdate.sinkBytes);
   * this renders whatever it is handed, in the order it was handed them.
   */
  private ratesLabel(now: number): string {
    if (this.sinkBytes === undefined) return "";
    const elapsedMs = this.lastRateSampleAt === null ? 0 : now - this.lastRateSampleAt;
    const parts: string[] = [];

    for (const [sink, total] of Object.entries(this.sinkBytes)) {
      const previous = this.lastSinkBytes[sink] ?? 0;
      if (elapsedMs > 0) {
        const instant = ((total - previous) * 1000) / elapsedMs;
        const smoothed = this.smoothedRates[sink];
        this.smoothedRates[sink] =
          smoothed === undefined
            ? instant
            : smoothed * (1 - MultiBarByteBar.RATE_SMOOTHING) +
              instant * MultiBarByteBar.RATE_SMOOTHING;
      }
      this.lastSinkBytes[sink] = total;
      const rate = this.smoothedRates[sink];
      if (rate !== undefined) parts.push(`${sink} ${prettyBytes(Math.round(rate))}/s`);
    }

    this.lastRateSampleAt = now;
    return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
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
   * thing that feeds cli-progress's own ETA sample buffer, see `dirty`
   * above. `setTotal` always runs (cheap, and doesn't touch the eta buffer
   * itself -- only `.update()`'s *value* does); the `.update()` call itself
   * is skipped unless `force` is set, for one of three cases that must
   * never wait for the next repaint: the very first flush (so the bar
   * isn't blank, and so a cold-start activity label reaches it instantly),
   * any update carrying a new `activity` (rare by construction -- at most
   * two per file, start and finish -- so bypassing the batching costs
   * nothing toward the flood that batching exists to suppress, and a user
   * watching the label for proof-of-life shouldn't wait on it), and
   * `stop()`'s final flush (`MultiBar.stop()` re-renders each bar's
   * *current* value one last time with `clearOnComplete: false`, so a
   * not-yet-landed update must land before that happens, or the run could
   * end on a stale snapshot).
   */
  private flush(force: boolean): void {
    this.overall.setTotal(Math.max(this.bytesTotal, 1));
    // Non-forced calls only mark `dirty` (above, in the two setters) and
    // leave the actual push for `flushPending` -- see that method's own
    // doc comment for why pushing here too would reintroduce the bug this
    // batching exists to fix.
    if (!force) return;
    this.push();
  }

  private push(): void {
    this.dirty = false;
    const now = Date.now();
    const approx = this.totalsFinal ? "" : "~";
    this.overall.update(this.bytesDone, {
      filesDone: String(this.filesDone),
      filesTotal: approx + String(this.filesTotal),
      sizeDone: prettyBytes(this.bytesDone),
      sizeTotal: approx + prettyBytes(this.bytesTotal),
      etaPrefix: approx,
      rates: this.ratesLabel(now),
      activity: this.activityLabel(),
    });
  }

  /**
   * Lands a push that a non-forced `flush` left batched, if `dirty` is
   * still set. Called from `MultiBarBytesProgressSession`'s own
   * `redraw-pre` listener -- fired by the underlying `MultiBar` immediately
   * before every repaint (node_modules/cli-progress/lib/multi-bar.js) --
   * so this can never run more often than the bar actually redraws, and it
   * also can never be starved the way the previous design was: that design
   * threw away any update that landed inside its own 100ms window unless
   * something later re-triggered a flush, which is exactly what left a bar
   * showing `0/~0 files` through an entire HEAD-check-then-download pause
   * with nothing left afterward to resend the dropped update. Driving the
   * push off the repaint itself instead means there is always a next
   * repaint to carry whatever is still dirty.
   */
  flushPending(): void {
    if (this.dirty) this.push();
  }

  setOverallTotals(totals: { files?: number; bytes?: number; final?: boolean }): void {
    // Grow-only while provisional, absolute once final -- see
    // ProgressSession.setOverallTotal for why the two differ. Clamped to
    // `done` so a final total that came in under what already finished
    // (an enumeration pass that over-counted, then the file vanished)
    // still can't render the bar past 100%.
    const becameFinal = totals.final === true && !this.totalsFinal;
    if (totals.final === true) this.totalsFinal = true;

    if (becameFinal || this.totalsFinal) {
      if (totals.files !== undefined) this.filesTotal = Math.max(totals.files, this.filesDone);
      if (totals.bytes !== undefined) this.bytesTotal = Math.max(totals.bytes, this.bytesDone);
    } else {
      if (totals.files !== undefined && totals.files > this.filesTotal) {
        this.filesTotal = totals.files;
      }
      if (totals.bytes !== undefined && totals.bytes > this.bytesTotal) {
        this.bytesTotal = totals.bytes;
      }
    }
    // Forced only on the provisional->final edge, never on an ordinary
    // revision: the format itself changes there (the "~" disappears), and
    // a revision-driven force would reintroduce exactly the flood of
    // `.update()` calls the batching above exists to suppress.
    this.dirty = true;
    this.flush(becameFinal);
  }

  setOverallProgress(current: {
    files?: number;
    bytes?: number;
    activity?: { verb: string; path: string } | undefined;
    sinkBytes?: Readonly<Record<string, number>> | undefined;
  }): void {
    if (current.files !== undefined) this.filesDone = current.files;
    if (current.bytes !== undefined) this.bytesDone = current.bytes;
    if (current.sinkBytes !== undefined) this.sinkBytes = current.sinkBytes;
    const isNewActivity = current.activity !== undefined;
    if (isNewActivity) this.activity = current.activity;
    this.dirty = true;
    this.flush(isNewActivity);
  }

  /**
   * Lands any update that was still batched, unconditionally.
   * `MultiBar.stop()` re-renders each bar's *current* value one last time
   * (with `clearOnComplete: false`), so without this a run could end on a
   * stale snapshot -- `flushPending` alone would do the same thing, but
   * only this method's unconditional push is guaranteed to run before
   * `stop()`'s own render rather than racing the next `redraw-pre`.
   */
  flushFinal(): void {
    this.flush(true);
  }
}

class MultiBarBytesProgressSession implements BytesProgressSession {
  private readonly multibar: MultiBar;
  private readonly bars: MultiBarByteBar[] = [];
  // Created on first use rather than in the constructor: a run that only
  // ever uses startPhase() (sync) must not also render an empty
  // session-level bar that nothing will ever advance.
  private ownBar: MultiBarByteBar | undefined;

  constructor(private readonly overallLabel: string) {
    this.multibar = new MultiBarCtor(
      // formatTime: formatEtaTime -- see its own doc comment above. This is
      // the session whose format string actually renders {eta_formatted}.
      { clearOnComplete: false, hideCursor: true, formatTime: formatEtaTime },
      Presets.shades_classic,
    );
    // Drives every bar's own batched-push mechanism (see MultiBarByteBar's
    // `dirty`/`flushPending`) off the MultiBar's actual repaint rather than
    // an independent timer of our own -- `redraw-pre` fires immediately
    // before each repaint (node_modules/cli-progress/lib/multi-bar.js), so
    // this lands the latest state exactly once per repaint, never more
    // often, and never leaves a bar stalled on stale numbers between
    // bursts of activity.
    this.multibar.on("redraw-pre", () => {
      for (const bar of this.bars) bar.flushPending();
    });
  }

  private own(): MultiBarByteBar {
    this.ownBar ??= this.startPhase(this.overallLabel) as MultiBarByteBar;
    return this.ownBar;
  }

  setOverallTotals(totals: { files?: number; bytes?: number; final?: boolean }): void {
    this.own().setOverallTotals(totals);
  }

  setOverallProgress(current: {
    files?: number;
    bytes?: number;
    activity?: { verb: string; path: string } | undefined;
    sinkBytes?: Readonly<Record<string, number>> | undefined;
  }): void {
    this.own().setOverallProgress(current);
  }

  startPhase(label: string): BytesProgressTarget {
    const bar = new MultiBarByteBar(this.multibar, label);
    this.bars.push(bar);
    return bar;
  }

  stop(): void {
    for (const bar of this.bars) bar.flushFinal();
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
export function reporterFor(session: BytesProgressTarget): OnProgress {
  return (update: ProgressUpdate) => {
    session.setOverallTotals({
      files: update.filesTotal,
      bytes: update.bytesTotal,
      final: update.totalsFinal,
    });
    session.setOverallProgress({
      files: update.filesDone,
      bytes: update.bytesDone,
      activity: update.activity,
      sinkBytes: update.sinkBytes,
    });
  };
}

let runLogFd: number | undefined;
let notifiedLogMissing = false;

/**
 * Called once, by `src/cli.ts`'s `preAction` hook, after it has opened
 * `--log`'s file (only when `--log` was given *and* this run will actually
 * show progress bars -- see that hook's own comment for why it's
 * conditional). `createLoggerForRun` below reads this module-level value
 * rather than taking the fd as one of its own parameters, since it's
 * called from every command's own action handler, long after `preAction`
 * has already run and far from anywhere that still has the fd in scope.
 */
export function setRunLogFd(fd: number): void {
  runLogFd = fd;
}

/**
 * Opens `--log`'s file and hands its fd to `setRunLogFd`, but only when
 * `showProgress` is true -- `--log` only ever matters once progress bars
 * are actually going to own stderr (see `createLoggerForRun`'s own doc
 * comment for why), so when they won't show at all this is a deliberate
 * no-op: `logPath` is never opened, and no file is ever created, matching
 * `createLoggerForRun`'s own `!showProgress` branch (always stderr, `--log`
 * or not).
 *
 * Called once, by `src/cli.ts`'s `preAction` hook, before any
 * command-specific work starts -- a bad path (an unwritable directory, a
 * permission error) throws here, failing the whole run immediately rather
 * than partway through, after bars are already on screen. Pulled out as its
 * own function (rather than inlined in that hook) specifically so it can be
 * unit-tested without a real terminal: `preAction` only ever observes a
 * real TTY's `showProgress`, but this function's own behavior is a pure
 * function of the two arguments, independent of how `showProgress` was
 * actually decided.
 */
export function openRunLogIfShowingProgress(
  logPath: string | undefined,
  showProgress: boolean,
): void {
  if (!logPath || !showProgress) return;
  let fd: number;
  try {
    fd = fs.openSync(logPath, "a");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot open --log file "${logPath}": ${message}`);
  }
  setRunLogFd(fd);
}

/**
 * While progress bars are rendering, they own stderr exclusively -- logging
 * (verbose or not) is diverted to the file `--log` named instead, opened by
 * `src/cli.ts`'s `preAction` hook via `setRunLogFd` above. This function
 * never opens a file itself -- only `preAction` does, once, before any
 * command-specific work starts, so a bad `--log` path fails the whole run
 * immediately rather than partway through.
 *
 * `--log` was *not* given (or this run won't show bars at all, which
 * `preAction` already knows and so never opens anything): logging is
 * silently discarded instead of corrupting the bars, after a one-time
 * notice pointing at `--log`.
 *
 * Previously this diverted to file descriptor 3, open only if the *caller*
 * redirected it there (`3>/tmp/x.log`) -- replaced because that detection
 * was unreliable: Node/libuv takes fd 3 for its own internal epoll/io_uring
 * handle at startup, so `fstatSync(3)` succeeded even with no redirect at
 * all, pointing the logger at libuv's own fd -- and the first warning-level
 * write then hung the entire process (sonic-boom's retry path spins
 * synchronously on the main thread). `--log` sidesteps the whole class of
 * bug: there's no ambient fd to collide with, since the file this opens is
 * one `preAction` itself created for exactly this purpose.
 */
export function createLoggerForRun(opts: { verbose: boolean; showProgress: boolean }): Logger {
  if (!opts.showProgress) {
    return createLogger(opts.verbose);
  }
  if (runLogFd !== undefined) {
    return createLogger(opts.verbose, pino.destination({ fd: runLogFd, sync: false }));
  }
  if (opts.verbose && !notifiedLogMissing) {
    notifiedLogMissing = true;
    process.stderr.write(
      "note: log output is being discarded while progress bars are active -- pass --log <file> to keep it\n",
    );
  }
  const discard: pino.DestinationStream = { write: () => true };
  return createLogger(false, discard);
}
