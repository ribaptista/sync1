# Concurrency, backpressure, and progress bars

Every command with a per-item loop (scanning the filesystem, checking S3 objects, uploading or
downloading content) follows the same shape: a synchronous **decide** step per item, and — only for
the items that need real I/O — an asynchronous **dispatch** that runs concurrently with the next
item's decide step, joined at the end. This doc covers that pattern, the foundation it's built on
(keyset pagination), the two different concurrency primitives used and why, and how progress bars and
`--verbose` logging share the terminal without corrupting each other.

## Keyset pagination: the foundation

Before any of this, every merge-join loop that used to hold a live `better-sqlite3` `.iterate()`
cursor open for its whole duration was converted to **keyset/seek pagination**
(`src/db/keyset-pagination.ts`): `WHERE <key> > ? ORDER BY <key> LIMIT N`, repeated, never `OFFSET`.
Each page is a plain `.all()` call — it runs to completion and frees the connection before any of its
rows are yielded to the caller, unlike a paused `.iterate()` cursor sitting mid-generator between
`.next()` calls.

This matters because of a precise, empirically-verified `better-sqlite3` constraint: a **write**
(`.run()`) on a connection fails if issued while **another statement's `.iterate()` cursor is paused**
on that _same_ connection. A plain read (`.get()`/`.all()`), or even a second `.iterate()` that's
immediately and fully drained within one synchronous turn, coexists fine with a paused cursor
elsewhere. Keyset pagination sidesteps the whole question by never leaving a statement paused in the
first place — which is what let several commands (`sanity_check`, `apply-remote-changes.ts`,
`commit.ts`, `materialize`, `stubify`) drop a second, read-only connection they'd been using purely as
a workaround, down to one.

**Every keyset-paginated query needs a matching index** covering both its filter and its ordering
column(s) — an index that only serves the filter (forcing a separate sort step) defeats the point.

## Never load an unbounded set into memory — but ask first

Streaming instead of materializing is the default, but it isn't a blanket rule applied reflexively:
before writing code that accumulates an unknown number of items into memory (a table scan, a glob
match, a filesystem walk), stop and ask whether that set is actually bounded in practice. Some are —
`inspect`'s glob-match collection and a dedup group sharing one content hash are both accepted as
unbounded-but-small-in-practice. Converting every such case to a stream/paginated form reflexively
would be its own kind of unnecessary complexity.

## Decide synchronously, dispatch concurrently, join at the end

The restructuring applied to `update_cache`, `sanity_check`, `sync`'s two passes, `materialize`,
`stubify`, `converge`/`status`, and `gc --apply` all follow one shape:

1. **Classify each item synchronously** as the merge-join/scan produces it — a directory, a stub, an
   already-correct/unchanged item, or something that needs real work. This part never awaits, so the
   producer loop can always tell instantly whether an item needs dispatch.
2. **Dispatch, don't await**, for the items that do need real work (hashing a file, an S3 HEAD/copy/
   restore/delete call, an upload, a download). The loop advances to the next item immediately; the
   dispatched job runs concurrently in the background.
3. **A job's own completion** does whatever depends on its result — building a row and inserting it,
   pushing a mismatch, or (in `sanity_check`/`materialize`) dispatching a _follow-on_ job to a second
   pool.
4. **Join before returning**: every dispatched job is drained (`onIdle()`, or an equivalent bounded
   tracker's drain) before the function returns its counts — this is also where a job's error actually
   surfaces, not at the point it was dispatched. A producer that dispatches jobs faster than they
   settle continuing on to more work is normal; a function returning success before its own dispatched
   work has actually finished or failed is not.

Where one job's completion enqueues a _second_ pool's job (`sanity_check`'s hash → S3 check,
`materialize`'s HEAD → download), **join order matters**: the first pool must be drained before the
second, since draining the second too early could miss a job that hadn't been enqueued yet.

`sync`'s two local-apply passes (deletes, then creates/modifies — see
[conflict-resolution.md](conflict-resolution.md)) are the one case needing real bookkeeping beyond a
plain dispatch/join: because a dispatched upload's `entries` row isn't written until the upload
actually completes, a _later_ row in the same batch that shares its hash (same-batch dedup) or
collides with its path (case-insensitivity) can't be caught by a plain database read alone. Two small
maps — bounded by the pool's own concurrency, since an entry only exists while its upload is genuinely
in flight — extend the existing dedup/collision checks to also see what's currently dispatched.
`apply-remote-changes.ts`'s downloads need no such bookkeeping: that pass does no cross-row dedup or
collision detection of its own.

## Two concurrency primitives, chosen per workload

- **`p-queue`** (`PQueue`) — a bounded async queue, used for the S3-call pool (`--s3-metadata-parallelism`,
  default 8), the file-content-pipeline pool (`--file-stream-parallelism`, default 4), and the thumbnail
  classification+generation pool (`--thumbnail-parallelism`, default 4 — see
  [thumbnails.md](thumbnails.md)). All three are dominated by waiting (network/disk I/O, or an external
  `identify`/`ffmpeg` subprocess), not CPU work on the main thread itself — concurrency helps by
  overlapping different items' waits. `PQueue` already has `.onIdle()`/`.pending`/`.size`, so no extra
  bookkeeping is needed beyond the shared backpressure helper (below).
- **`piscina`** (real OS worker threads) — used only for `--hash-parallelism` (file hashing in
  `update_cache`/`sanity_check`/`stubify`). Hashing many _different_ files is the one place in this
  plan that's genuinely CPU-bound and embarrassingly parallel across files, so it's the one place
  worth spending real threads rather than main-thread async concurrency. `Piscina` must be imported as
  the **named** export (`import { Piscina } from "piscina"`) — the default-export form compiles and
  runs fine under `tsx`/`vitest`, but fails a real `tsc` build with `TS2351: This expression is not
constructable`.

Every command that dispatches hash jobs takes the hash pool through a small `HashRunner` interface
(`{ run: (absolutePath, onBytes?) => Promise<string> }`) rather than a concrete `Piscina` type —
production passes `createHashRunner(pool)`, and unit tests inject a fake, synchronous-ish
implementation instead of spinning up real worker threads (slow, and pointless for testing the
merge-join logic itself, which is the actual complexity).

The adapter exists because a worker thread can't reach the progress bar directly: it writes its
running byte count into a `SharedArrayBuffer` handed in with the task, and the main thread samples that
on a timer. Shared memory rather than a `MessageChannel` — a port would have to be transferred in,
listened to, and closed on every exit path, including the ones that reject before the handler runs
(which leaks the worker-side port and hangs pool shutdown), whereas a `SharedArrayBuffer` is plain
memory that gets collected. It also leaves throttling to the reader, which knows the bar's redraw rate,
rather than making the writer guess at a chunk interval. The counter is a `BigInt64Array`: a 32-bit one
wraps at 2.1GB, on exactly the multi-GB video this is for.

Note `HashRunner.run` is declared as a **property**, not a method. Method syntax is checked
bivariantly even under `strict`, so a bare `Piscina` — whose own `run(task, options?)` takes an options
object second — would keep on structurally satisfying the interface while silently passing a callback
where piscina expects its options. As a property, `strictFunctionTypes` applies contravariantly and
every un-migrated call site is a compile error instead.

## Backpressure: never let a producer outrun what it feeds

A producer (a merge-join loop, a paginated scan) that dispatches jobs without limit just replaces "one
big array in memory" with "one big implicit queue of pending closures" — exactly the unbounded-memory
problem pagination exists to avoid, one layer up. Two small helpers in `src/concurrency/pools.ts`
enforce a cap everywhere a producer feeds a pool:

- **`waitForRoom(pool, limit)`** — for `p-queue` pools: awaits `pool.onSizeLessThan(limit)` when
  `pool.size + pool.pending >= limit`, then the caller dispatches via the pool's own `.add()`.
- **`BoundedTaskTracker`** — for the hash pool (`piscina` has no `onSizeLessThan` equivalent):
  `dispatch(task)` awaits room in an internal bounded set, starts `task()`, and resolves once it's
  been _started_ — not once it _completes_. That distinction is what lets a producer fire a job and
  immediately move on to the next item, while still never getting more than `limit` jobs ahead of what
  the pool can actually run. `onIdle()` is the join step, and re-throws the first error from any
  dispatched task that failed — even one that had already settled (and been removed from the internal
  set) before `onIdle()` was called; a task's rejection is captured immediately so it never becomes an
  unhandled promise rejection in the gap between settling and being joined.

Every dispatch and completion logs the pool's current occupancy —
`logger.debug({ pool: "hash", inFlight, queued }, "dispatched" | "completed")` — using the existing
structured-logging convention. This is what lets an e2e test observe _real_ concurrency behavior
(parsing `--verbose` stderr for `max(inFlight)`) rather than only checking final correctness, which
can't distinguish a correctly-bounded pool from an accidentally-sequential or accidentally-unbounded
one: such a test asserts both that the configured limit was **never exceeded** and that it was
**actually reached** at some point.

## Progress bars and `--verbose`, sharing a terminal

`src/cli/progress.ts` decides whether to show bars at all (`shouldShowProgress`: never for `--json` or
`--no-progress`, otherwise only when stderr is a real TTY) and, when it does, owns stderr exclusively —
a rendering progress bar and interleaved log lines would corrupt each other. So while bars are active,
`--verbose` output is diverted to file descriptor 3 instead (`createLoggerForRun`), which is only ever
open if the _caller_ redirected it there (`sync1 sync --verbose --root ~/x 3>/tmp/sync1.log`) — the
tool never opens a file itself. If fd 3 isn't open, verbose output is silently discarded (after a
one-time notice explaining why) rather than corrupting the bars or crashing.

`src/cli/progress.ts` exposes **two** session types, chosen per command by what that command actually
measures:

- **`ProgressSession`** (`startProgressSession`) — a plain item-count bar (`{value}/{total} <unit>`),
  used by `gc`, `converge`, `status`, and `thumbnail`. None of those transfer or hash file content, so a
  byte total wouldn't mean anything for them. `thumbnail state`/`cleanup` drive the bar from a single
  filesystem-walk callback (`{scanned files}/{scanned files}`, since neither mode does anything besides
  scan). `thumbnail ensure` is the one command driving the same session from _two independent_ callbacks
  instead of one: a walk-phase callback it doesn't actually use (see
  [thumbnails.md](thumbnails.md#parallelism) for why), and a separate generation-phase callback whose
  total is "thumbnails still pending" and whose value is "thumbnails generated so far" — two units that
  can't be expressed as one running count, unlike every other `ProgressSession` user in this list.
- **`BytesProgressSession`** (`startBytesProgressSession`) — used by every command that actually
  hashes, uploads, or downloads file content: `update_cache`, `sync`, `materialize`, `stubify`, and
  `sanity_check`. A single bar shows both a file count and a byte count, but **only bytes ever drive
  the bar's own internal total/current** — and therefore `{eta_formatted}`'s real math — since an ETA
  derived from item _count_ alone would be misleading when file sizes vary wildly (hashing one 4GB
  video vs. ten 1KB text files). File counts ride along purely as custom payload tokens, cosmetic only:

  ```
  ${label} |{bar}| {filesDone}/{filesTotal} files, {sizeDone}/{sizeTotal} -- ETA {eta_formatted} {activity}
  ```

  `{eta_formatted}` (and `{duration_formatted}`) are `cli-progress`'s own built-in tokens — the bar
  computes ETA automatically from real `total`/`current` values fed to it. An earlier iteration of this
  code had a fully-implemented but never-wired-up nested-bar API (`ChildBar`/`addChildBar`) that
  hand-rolled its own throughput/rate math; it was deleted outright rather than adapted, since its
  per-file-nested-bar shape didn't fit "one combined overall bar" anyway, and `cli-progress` already
  does this correctly for free. That judgement still stands, and one bar per parallel worker was
  reconsidered and rejected again since: `MultiBar` redraws by moving the cursor up `dy` lines, so the
  moment the stack outgrows the terminal's height the origin is lost and the display degrades into
  repeating bars — and a hash pool defaults to one thread per CPU.

  "`cli-progress` already does this correctly for free" has one sharp edge: its ETA is a naive linear
  rate over a **fixed 10-sample ring buffer** of `(value, timestamp)` pairs, refilled on every call to
  the bar's own `.update()` — and `cli-progress`'s `fps: 10` only throttles the terminal _write_, not
  that buffer. This codebase used to call `.update()` on every producer emit: every row a scan resolves
  without needing work, and every in-flight hash's `SharedArrayBuffer` byte counter polled on its own
  100ms timer (`src/concurrency/hash-runner.ts`) — with N threads hashing concurrently, up to N more
  calls roughly every 100ms. That could shrink the buffer's captured window to single-digit
  milliseconds, and a rate computed over a window that small is noise: a sliver with near-zero movement
  sends the estimate toward infinity (displayed, thanks to a formatter that assumes a number, as the
  literal mangled string `"NFs"`), and a sliver containing a burst of files finishing at once sends it
  the other way, so `remaining/rate` rounds to `0` — `"ETA 0s"` while a run is nowhere near done.
  Raising `etaBufferLength` doesn't fix this: the failure is driven by call _rate_, not burst size, so
  no fixed buffer resists an arbitrary thread count, and a big enough buffer to help would also blur
  the one place accuracy matters most — the run's final stretch, once only large files remain and the
  true rate genuinely drops. Instead, `MultiBarBytesProgressSession` still updates its own bookkeeping
  on every call (cheap), but throttles the push into the bar itself to once per 100ms — matched to
  `cli-progress`'s own redraw rate, so nothing visible slows down — with three deliberate exceptions:
  the very first flush (so the bar isn't blank and a cold-start activity label lands instantly), any
  update carrying a new `activity` (rare by construction, so bypassing costs nothing), and `stop()`
  (which forces one last flush before `MultiBar.stop()` re-renders each bar's current value, so a run
  never ends on a stale throttled snapshot).

  `{activity}` is what replaced it: a single trailing label naming the file currently being worked on,
  written by whichever producer is running. It flips at **two** moments per file — `hashing <path>...`
  when that file's job starts and `hashed <path>...` when it finishes (`uploading`/`uploaded`,
  `downloading`/`downloaded` likewise). Labelling only completion would have been simpler but leaves
  the label empty for however long the first file of a run takes, which is precisely the dead-air case
  the label exists to fill. Paths flash past unreadably on small files; that's accepted — the bar
  redraws at 10fps regardless, so it's a rolling sample, not a log. `fitPath` truncates to the terminal
  width keeping the **tail**, since the filename is the informative end and `linewrap: false` means the
  terminal would otherwise clip the head. The verbs are supplied by each producer, never enumerated in
  `src/cli/progress.ts` — the bar renders whatever word it is handed and knows nothing about hashing or
  S3, which is also what lets each of `sync`'s three phase bars carry its own verb.

Both session types share the same **provisional-until-final** convention for totals and the same
null-object pattern (a no-op session when bars shouldn't show, so a command's own logic never branches
on whether bars are actually rendering). A total arrives with a `final` flag: while it's provisional,
`setOverallTotal`/`setOverallTotals` only ever _grow_ it (a running scan's discovery count can't be
allowed to jitter downward), and the bar renders it as approximate — `~1.2 GB`, `~4/~9 files`,
`~ETA 4m`. Once a total is declared final it's set absolutely, downward revisions included, clamped to
what's already done so the bar can never render past 100%. Only the provisional→final edge forces a
flush past the throttle described below, since that's where the format itself changes; ordinary
revisions must not, or they'd reintroduce exactly the flood the throttle exists to damp.

Downward revision is safe only because the tracker keeps _observation_ and _estimation_ in separate
counters and emits `max(observed, estimated)`. An estimate revised down can therefore never drag the
denominator below what has already finished; at worst it stops raising it. `settle()` (estimate :=
observed, and final) is what lands a run on exactly 100% whichever way the estimate was wrong.

Every domain function in `BytesProgressSession`'s scope takes an `onProgress?: OnProgress` parameter
(`src/progress-types.ts` — kept as its own leaf module, not part of `src/cli/*`, since `src/fs/*` and
`src/sync/*` never import from `src/cli/*` and this type needs to cross that boundary without inverting
it) and reports `{ filesDone, filesTotal, bytesDone, bytesTotal, totalsFinal, activity? }`. None of them build that
object by hand: they all drive a `createProgressTracker`, which owns the counting rule in one place
rather than in six near-identical `report()` closures.

The counting rule is the same everywhere. **`filesTotal` counts every row a scan/merge-join has
_discovered_; `filesDone` counts the ones whose work has actually _resolved_** — a row needing no
async work resolves the moment it's seen, so the two only diverge by what is genuinely in flight. They
were previously the same variable, which is why the bar used to read a pinned `X/X`. Note the gap this
opens is bounded by pool concurrency, since the producers block once the pool is full — which is
exactly why discovery alone can't produce an honest denominator, and why enumeration is split out from
execution (below).

**`bytesDone`/`bytesTotal` count only content actually hashed/uploaded/downloaded this run** — a
directory, an already-resolved stub (hash read from the stub file itself, never hashed), a
no-op/unchanged/dedup-skip row, and (for `stubify`) the common mtime-unchanged fast path all contribute
exactly 0 to both. A size is known synchronously (from cache.db's `entries.size` column, or from
`objects.size` for anything keyed by content hash) at classification time, before a job is dispatched —
so `bytesTotal` grows at dispatch (`expectBytes`), the same decide/dispatch/join shape as everything
else in this doc.

`bytesDone`, though, is **completed bytes plus the partial progress of everything in flight**, not just
whole files at completion. That distinction is the point of the whole mechanism: since bytes alone
drive the bar's fill and its ETA, counting only completed files froze both for as long as one large
file took. Each in-flight file reports through a `FileTracker` fed by whichever byte source fits that
pipeline — `countingReadable` around the plaintext read for uploads, an `onBytes` hook in
`decryptStreamToFile`'s plaintext loop for downloads, and a shared-memory counter sampled off the
worker thread for hashing (see `createHashRunner`). All three are denominated in **plaintext** bytes so
they sum to exactly the size the tracker was opened with; ciphertext byte counts run larger and would
overrun the declared total. A file's partial contribution is clamped to its own size and `finish()` is
idempotent and called from a `finally`, which together keep `bytesDone` monotonic — the one counter
nothing is ever allowed to walk back, since it's what the bar's fill is drawn from.

## Enumeration vs. execution

A run's denominator used to come from the same loop that did the work, so it climbed for almost the
whole run: work was counted as it was _discovered_, and discovery is throttled by backpressure from the
pool doing the slow part. The bar and its ETA only became meaningful as a run finished — exactly when
they stop being useful.

So **enumeration is separated from execution**. A cheap, offline, unbackpressured pass counts what the
run is about to do and publishes it through `setEstimatedTotals`; the real pass decides everything for
itself, as before.

**The denominator principle: the total counts items this run is responsible for _resolving_, decided
offline — not items that will turn out to need transfer or generation.** An object that turns out to be
archived resolves by requesting retrieval; a glob-matched file that probes as non-media resolves by
being skipped; a conflicting dirty row resolves by being reported. All of them advance the bar without
moving bytes. This is what keeps enumeration cheap enough to be honest, and it's why no counting pass
ever issues a network request — a pass that did would be throttled by the very pool it exists to
explain, and its answer could go stale before the real pass reached it.

| Command                        | How the total is known                                                         | Extra I/O      |
| ------------------------------ | ------------------------------------------------------------------------------ | -------------- |
| `gc`                           | already computed by `countStagedOrphans()`                                     | none           |
| `converge` / `status`          | `countDistinctHashesMatchingGlob(filter)`                                      | none (DB scan) |
| `materialize`                  | glob match + `existsSync` stub + `objects.size`                                | stat only      |
| `sync` phase 2                 | `enumerateUploadWork`: dirty rows' `entries.size`, dedup skipped via `objects` | none           |
| `update_cache`, `sync` phase 1 | concurrent counting walk (`update-cache-enumerate.ts`)                         | one extra walk |
| `sanity_check`                 | concurrent counting merge-join (`sanity-check-enumerate.ts`)                   | one extra walk |
| `stubify`                      | concurrent counting scan over cache rows (`stubify-enumerate.ts`)              | stat only      |
| `thumbnail state`/`cleanup`    | concurrent counting walk (`thumbnail-enumerate.ts`)                            | one extra walk |
| `thumbnail ensure`             | exact: every generation candidate is decided before the first is dispatched    | none           |

The walking/scanning passes run **concurrently** with the real pass, not before it: on an unchanged
tree the walk _is_ the entire cost of `update_cache`, so a sequential pre-pass would roughly double the
runtime of by far the most common case — a no-op `sync` — in exchange for a bar nobody is watching. Run
alongside, the cost is overlapped and the dentry cache is warmed for the pass following behind.

Every such pass is **advisory in the strongest sense**: it never throws (a failure just means the run
proceeds with the denominator it would have had anyway), never mutates anything, and its numbers are
only ever a floor-raising estimate that `settle()` discards at the end. There is therefore no staleness
protocol, no mtime revalidation and no persisted work list: the real pass re-decides from scratch, and
any disagreement is absorbed by `max(observed, estimated)` on the way up and by `settle()` on the way
down. Each is cut short by an `EnumerationControl { stop }` flag and joined in a `finally`, so it can
never publish into a tracker that has already settled.

Two concurrent iterations on one SQLite connection are safe here because repository iterators are
keyset-paginated (`src/db/keyset-pagination.ts`): each page is a `.all()` that drains in one
synchronous turn, so neither pass ever leaves a cursor _paused_ — the only thing better-sqlite3
actually forbids (see the note at the top of this document).

## `sync`: one bar per phase

`performSync` runs three phases fully sequentially — `performUpdateCache` (hashing),
`applyLocalChangesToCandidate` (uploading), `applyRemoteChangesToLocal` (downloading) — each reporting
its own progress from zero. They used to be welded into a single bar by a `base` offset accumulated
across phase boundaries. They now get **one bar each**, minted lazily as its phase begins
(`BytesProgressSession.startPhase(label)`, within the `MultiBar` the session already owned).

A combined denominator was never a real quantity: phase 2 works on the dirty set phase 1 produces, and
phase 3 diffs against a candidate DB that doesn't exist until the remote snapshot has been fetched, so
no counting pass could ever have known the grand total up front. Summing was also apples-to-oranges — a
gigabyte hashed off a local disk and a gigabyte pushed over an uplink are not the same work — which
made the single combined ETA partly fiction. Three ETAs over homogeneous workloads are each genuinely
accurate. Two failure modes disappear rather than needing handling: an inflated _estimate_ being baked
permanently into the offset, and `totalsFinal` leaking out of phase 1 to claim a trustworthy
denominator while two-thirds of the run is unaccounted for.

Bars are created when their phase actually starts, never up front: a bar sitting at 0 for a phase whose
inputs don't exist yet is a lie with a progress indicator attached. `clearOnComplete: false` means the
run ends showing all three, complete, as a summary. Known and accepted: the gap between phase 1 and
phase 2 — an S3 `getObject` for `/current`, plus downloading and decrypting the whole remote state.db
when the remote moved — reports nothing. With one bar that read as "frozen"; with three it reads as
"phase 1 done, phase 2 not started", which is the same reality correctly attributed.
