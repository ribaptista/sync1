/**
 * The progress-reporting shape shared by every content-processing domain
 * function (update_cache, sync, materialize, stubify, sanity_check) and
 * `src/cli/progress.ts`'s `BytesProgressSession`. Deliberately its own leaf
 * module rather than living in `src/cli/progress.ts`: `src/fs/*.ts` and
 * `src/sync/*.ts` never import from `src/cli/*` today (`cli` sits above
 * `fs`/`sync`, only `commands/*.ts` bridges them), and this type needs to be
 * importable from both sides of that boundary without inverting it.
 *
 * `filesTotal` counts every row a scan/merge-join has *discovered*;
 * `filesDone` counts the ones whose work has actually *resolved*. A row
 * needing no async work resolves the moment it's seen, so the two diverge
 * only by what is genuinely in flight -- they used to be the same variable,
 * which is why the bar read a pinned "X/X". Both count every row, whether
 * or not it needed hashing/uploading/downloading: that's "how far through
 * the tree" visibility.
 *
 * `bytesDone`/`bytesTotal` count only content actually hashed/uploaded/
 * downloaded this run -- a directory, an already-resolved stub, a
 * no-op/unchanged/dedup-skip row, and (for stubify) the common
 * mtime-unchanged fast path all contribute 0 to both. This is what makes
 * bytes a meaningful basis for an ETA where item counts alone wouldn't be
 * (file sizes vary wildly), and it's why `bytesDone` includes the partial
 * progress of in-flight files rather than whole files at completion:
 * bytes drive the bar's fill and its ETA, so counting only completions
 * froze both for as long as a single large file took.
 */
export interface ProgressUpdate {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /**
   * False while either total is still a projection an enumeration pass
   * supplied and the run might yet contradict; true once the totals are
   * the run's own observed truth. Renderers use it to mark the total (and
   * the ETA derived from it) as approximate -- see `src/cli/progress.ts`.
   */
  totalsFinal: boolean;
  /**
   * The most recent per-file event this tracker observed, already resolved
   * to its word (e.g. `{ verb: "hashing", path: "a.jpg" }`) -- rendered
   * verbatim by the bar, which carries no vocabulary of its own. Absent
   * before the first `startFile()` call. `?: T | undefined` rather than
   * `?: T`: exactOptionalPropertyTypes is on, and createProgressTracker
   * below builds every update from a single object literal whether or not
   * this field applies, rather than conditionally spreading it in.
   */
  activity?: { verb: string; path: string } | undefined;
}

export type OnProgress = (update: ProgressUpdate) => void;

/**
 * The two words a producer's activity label uses for one file's lifecycle,
 * e.g. `["hashing", "hashed"]` or `["uploading", "uploaded"]`. Supplied by
 * the caller of `createProgressTracker`, never enumerated here or in
 * `src/cli/progress.ts` -- each producer does exactly one kind of byte work
 * and names its pair once, so the bar renders whatever word it's handed
 * without knowing anything about hashing, S3, or any other domain concept.
 */
export type ActivityVerbs = readonly [started: string, finished: string];

/** Tracks one in-flight file's contribution to its tracker's `bytesDone`. */
export interface FileTracker {
  /**
   * Reports `deltaBytes` more bytes read/written for this file since the
   * last call (matching `countingReadable`'s `onBytes(chunk.length)` --
   * a delta, not a running total). Clamped so this file's own partial
   * contribution never exceeds the `size` given to `startFile`: a source
   * that over-reports would otherwise push `bytesDone` past `bytesTotal`,
   * which is the invariant that actually matters here.
   * A no-op once `finish()` has been called.
   */
  advance(deltaBytes: number): void;
  /**
   * This file's transfer failed transiently and is about to be retried from
   * the beginning: **discards the partial bytes it had accumulated** and
   * emits a label saying so.
   *
   * Discarding is the honest accounting. `bytesDone` is
   * `completedBytes + Σ in-flight partials`, so dropping this file's
   * partial rewinds the bar to the last state actually committed to disk or
   * to S3 -- which is exactly what a restarted transfer has to re-earn. The
   * alternative, leaving the partial in place, would have the next
   * attempt's `advance` calls pile on top of bytes that no longer exist
   * anywhere, and only the clamp in `advance` would stop the file
   * over-claiming. `bytesDone` is otherwise non-decreasing; this is the one
   * deliberate exception, and it moves for a real reason.
   *
   * Carries `attempt` *and* `elapsedMs` because retries have no attempt
   * limit (`src/s3/retry.ts`): a label that only said "retrying" would look
   * identical after one minute and after one hour, which is how an
   * indefinite retry becomes indistinguishable from a hang.
   *
   * The label is composed here even though this module is otherwise
   * vocabulary-free (see `ActivityVerbs`): "retrying" is not a domain word
   * the way `hashing`/`uploading` are -- every producer's retry says the
   * same thing -- so there is nothing for a producer to name.
   *
   * A no-op once `finish()` has been called.
   */
  retrying(notice: { attempt: number; delayMs: number; elapsedMs: number }): void;
  /**
   * Moves this file's contribution from in-flight partial to completed --
   * always the full `size`, regardless of how much `advance` actually
   * reported, so a file whose byte source never fires (or under-reports)
   * still finishes exactly accounted for. Call this only once the transfer
   * has genuinely succeeded; see `abort()` for the failure counterpart.
   * Idempotent, and mutually idempotent with `abort()` -- once either has
   * been called, the other (and any further call to either) is a no-op,
   * which matters because a job's success and failure cleanup paths can
   * both end up calling into this contract from the same `finally`.
   */
  finish(): void;
  /**
   * This file's transfer failed outright (not a retry -- see `retrying()`
   * for that) and will not be attempted again by this job. **Discards the
   * partial bytes it had accumulated, same as `retrying()`, but -- unlike
   * `finish()` -- never adds `size` to the tracker's completed total**: a
   * file whose content never reached its destination must not be reported
   * as transferred. This is what makes it safe for a caller to treat a
   * caught upload/download failure as non-fatal (leaving the row dirty,
   * say) without the bar silently claiming the failed bytes as done.
   *
   * No activity label, deliberately: unlike a retry (which can run for
   * minutes and needs an ongoing "something is happening" signal), an
   * abort is terminal and instantaneous -- the file simply stops being in
   * flight. The caller's own logging is the right place to say why.
   *
   * Idempotent, and mutually idempotent with `finish()` -- see its own
   * doc comment.
   */
  abort(): void;
}

/**
 * One shared tracker replacing what used to be six duplicated `report()`
 * closures (one per producer) plus their own local `ByteTracking`
 * interfaces. `bytesDone` is always `completed bytes + Σ in-flight
 * partials`, which is what keeps the bar (and its ETA, driven entirely by
 * bytes) moving *during* a large file instead of freezing until it
 * finishes -- see the module-level design note in `src/cli/progress.ts`.
 */
export interface ProgressTracker {
  /** A row was discovered by the scan -- `filesTotal`++. */
  rowDiscovered(): void;
  /** A row's async work resolved (whether or not it needed byte work) -- `filesDone`++. */
  rowResolved(): void;
  /**
   * A file's bytes were dispatched for work -- `bytesTotal` grows by
   * `size`. Deliberately separate from `startFile` (job *start*, not
   * dispatch): existing tests assert `bytesTotal` grows before `bytesDone`
   * ever moves for that file, matching `trackDispatched`/`trackCompleted`
   * from the old per-producer `ByteTracking` interfaces this replaces.
   */
  expectBytes(size: number): void;
  /**
   * A file's byte work actually started -- emits the caller's first verb
   * (`verbs[0]`) against `path` immediately, which is what keeps the label
   * from sitting empty for the minutes it can take to process the very
   * first (and possibly only, for a while) large file of a run. Returns a
   * `FileTracker` for reporting that file's progress and completion.
   */
  startFile(path: string, size: number): FileTracker;
  /**
   * Bytes that were counted toward the total but resolved without any
   * transfer at all -- an archived object a run can only request a
   * restore for, say. Completes them outright, and deliberately emits no
   * activity label: nothing was read or written, so claiming
   * "downloading …" for it would be a lie.
   *
   * The alternative -- leaving them out of the total entirely -- would
   * mean the denominator couldn't be known until every object had been
   * classified, which for the commands that need this is the whole run.
   */
  skipBytes(size: number): void;
  /**
   * A projection of this run's eventual totals, from an enumeration pass
   * that counted the work without doing any of it -- absolute, not a
   * delta, and free to move in *either* direction as that pass revises
   * itself. Safe to lower precisely because it's kept separate from the
   * observed counters above rather than overwriting them: every emitted
   * total is `max(observed, estimated)`, and `observed >= done` already
   * holds by construction, so no estimate -- however wrong, even zero --
   * can ever drag a total below what's already finished. An estimate is
   * therefore never load-bearing for correctness, only for usefulness,
   * which is what makes it safe to feed from a concurrent pass nobody is
   * verifying.
   *
   * `final: true` means "this is exact, not a projection" -- for the
   * commands that can count their work outright (a SQL count, say) with
   * nothing left to revise.
   */
  setEstimatedTotals(totals: { files?: number; bytes?: number; final?: boolean }): void;
  /**
   * The run is over, so whatever it actually observed *is* the truth:
   * drops any remaining estimate and marks the totals final. Call it from
   * a `finally` -- it's what makes a run end at exactly 100% when the
   * enumeration pass over- or under-counted because the tree shifted
   * underneath it, instead of stalling at 99.7% forever.
   */
  settle(): void;
}

/**
 * Builds a `ProgressTracker` that calls `onProgress` (if given) with a
 * fresh `ProgressUpdate` object on every state change -- fresh, not
 * mutated in place, because `commit.ts`'s `phaseProgress` stores the
 * reference it's handed rather than snapshotting fields off it.
 *
 * `onProgress` is optional so a caller that never wired up progress
 * reporting (or is running under `--json`/`--no-progress`, where nothing
 * renders) doesn't need to build a no-op function just to hand one in.
 */
/**
 * Coarse, single-unit duration for a progress label -- `4s`, `21m`, `2h05m`.
 * Rounded up so a sub-second wait reads as `1s` rather than `0s`, which
 * would look like nothing is happening.
 */
function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function createProgressTracker(
  onProgress: OnProgress | undefined,
  verbs: ActivityVerbs,
): ProgressTracker {
  let filesDone = 0;
  // "observed*" is what this run has actually seen and is grow-only, as it
  // always was; the "estimated*" pair is the separate projection channel
  // described on setEstimatedTotals. Emitting max() of the two is the whole
  // reason a projection may be revised downward without the bar ever
  // rendering a total below `done`.
  let observedFiles = 0;
  let observedBytes = 0;
  let estimatedFiles = 0;
  let estimatedBytes = 0;
  let totalsFinal = false;
  let completedBytes = 0;
  let inFlightBytes = 0;

  function emit(activity?: { verb: string; path: string }): void {
    onProgress?.({
      filesDone,
      filesTotal: Math.max(observedFiles, estimatedFiles),
      bytesDone: completedBytes + inFlightBytes,
      bytesTotal: Math.max(observedBytes, estimatedBytes),
      totalsFinal,
      activity,
    });
  }

  return {
    rowDiscovered() {
      observedFiles++;
      emit();
    },
    rowResolved() {
      filesDone++;
      emit();
    },
    expectBytes(size) {
      observedBytes += size;
      emit();
    },
    skipBytes(size) {
      completedBytes += size;
      emit();
    },
    setEstimatedTotals(totals) {
      if (totals.files !== undefined) estimatedFiles = totals.files;
      if (totals.bytes !== undefined) estimatedBytes = totals.bytes;
      // Only ever latches on: a total that has been declared exact can't
      // become provisional again, and `settle()` below is the only other
      // way in.
      if (totals.final === true) totalsFinal = true;
      emit();
    },
    settle() {
      estimatedFiles = observedFiles;
      estimatedBytes = observedBytes;
      totalsFinal = true;
      emit();
    },
    startFile(path, size) {
      // This file's own share of inFlightBytes -- tracked locally rather
      // than trusting the caller to report a total, since advance() only
      // ever hands us a delta (mirroring countingReadable's onBytes).
      let partial = 0;
      let finished = false;

      emit({ verb: verbs[0], path });

      return {
        advance(deltaBytes) {
          if (finished) return;
          // partial <- min(size, partial + deltaBytes): clamped so this
          // file can never claim more than its own declared size, however
          // much its byte source over-reports.
          const clamped = Math.min(size, partial + deltaBytes) - partial;
          partial += clamped;
          inFlightBytes += clamped;
          emit();
        },
        retrying(notice) {
          if (finished) return;
          // Hand back every byte this attempt had claimed. `partial` is
          // this file's own share of inFlightBytes, so the two move
          // together and bytesDone lands exactly where it stood before the
          // attempt began.
          inFlightBytes -= partial;
          partial = 0;
          emit({
            verb: `retrying in ${formatDuration(notice.delayMs)} (attempt ${notice.attempt}, failing for ${formatDuration(notice.elapsedMs)})`,
            path,
          });
        },
        finish() {
          if (finished) return;
          finished = true;
          // Full `size`, not `partial`: a file that finished without ever
          // reporting every byte (or any) still needs to land at exactly
          // `size` in completedBytes, or the phase total would fall short
          // once every file has finished.
          completedBytes += size;
          inFlightBytes -= partial;
          emit({ verb: verbs[1], path });
        },
        abort() {
          if (finished) return;
          finished = true;
          // Same rewind as retrying() -- give back this file's own share
          // of inFlightBytes -- but nothing is added to completedBytes:
          // this file never actually finished, so it must not be counted
          // as transferred. No activity emitted; see this method's own
          // doc comment on FileTracker.
          inFlightBytes -= partial;
          emit();
        },
      };
    },
  };
}
