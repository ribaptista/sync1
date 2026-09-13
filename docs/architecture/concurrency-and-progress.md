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
  default 8) and the file-content-pipeline pool (`--file-stream-parallelism`, default 4). Both are
  I/O-bound: concurrency helps by overlapping different items' network/disk waits, not by using more
  CPU cores. `PQueue` already has `.onIdle()`/`.pending`/`.size`, so no extra bookkeeping is needed
  beyond the shared backpressure helper (below).
- **`piscina`** (real OS worker threads) — used only for `--hash-parallelism` (file hashing in
  `update_cache`/`sanity_check`/`stubify`). Hashing many _different_ files is the one place in this
  plan that's genuinely CPU-bound and embarrassingly parallel across files, so it's the one place
  worth spending real threads rather than main-thread async concurrency. `Piscina` must be imported as
  the **named** export (`import { Piscina } from "piscina"`) — the default-export form compiles and
  runs fine under `tsx`/`vitest`, but fails a real `tsc` build with `TS2351: This expression is not
constructable`.

Every command that dispatches hash jobs takes the hash pool through a small `HashRunner` interface
(`{ run(absolutePath): Promise<string> }`) rather than a concrete `Piscina` type — production passes
the real pool (which already satisfies the shape), and unit tests inject a fake, synchronous-ish
implementation instead of spinning up real worker threads (slow, and pointless for testing the
merge-join logic itself, which is the actual complexity).

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

`startProgressSession` returns a real `cli-progress` `MultiBar`-backed session when bars should show,
or a no-op "null object" session otherwise — callers always call the same `setOverallTotal`/
`advanceOverall`/`addChildBar` methods either way, so a command's own logic never branches on whether
bars are actually rendering. A bar's total can grow live as a scan discovers more items than an
initial estimate (the same `setTotal`-on-overflow behavior every such command shares), since the true
total often isn't known upfront for a glob-scoped or whole-tree scan.
