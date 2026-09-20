# Filesystem scanning and cache.db

## Why cache.db isn't encrypted

The vault password scopes state.db, content objects, and `vault.json` — not `cache.db`. cache.db is
purely local, regenerable at any time by rescanning the filesystem, and reveals nothing the
already-unencrypted local files (which it's a cache _of_) don't already reveal. This is also why
`update_cache` never prompts for a password or touches S3 at all — it's a pure local operation.

## The sorted merge-join, and why a naive directory traversal gets it wrong

`update_cache` needs to diff the live filesystem against `cache.db` without loading either side fully
into memory — critical given the target content is exactly the kind of thing that doesn't fit in
memory cheaply (multi-GB video libraries). The technique is a streaming merge-join: both the
filesystem walk (`src/fs/walker.ts`) and the cache.db read (`CacheEntriesRepository.iterateAllSortedByPath()`)
produce their entries in the _same_ lexicographic order that SQL's `ORDER BY path` would, so
`update_cache` can advance both iterators in lockstep, comparing paths, and never needs either side
fully materialized.

Getting the filesystem walker to actually produce that order is the subtle part. A naive traversal —
sort each directory's children alphabetically, recurse into a subdirectory as soon as you reach it —
is wrong. Consider siblings `a` (a directory), `a!`, `a.txt`, `a/b.txt` (nested inside `a`), and `ab`.
Comparing raw bytes: `!` is `0x21`, `.` is `0x2E`, `/` is `0x2F`, `b` is `0x62` — so the true
lexicographic order of the path _strings_ is:

```
a  <  a!  <  a.txt  <  a/b.txt  <  ab
```

A naive traversal that recurses into `a` immediately after emitting it would produce `a, a/b.txt, a!,
a.txt, ab` — wrong, because `a/b.txt` needs to sort _after_ `a.txt` (since `.` < `/`) but _before_ `ab`
(since `/` < `b`), not immediately after `a` itself.

The fix: each directory contributes **two** items to its parent's sort list, not one — its own bare
path (sort key = its name) and a "recurse marker" (sort key = `name + "/"`). Files contribute one item
each (sort key = their name). All of a directory's siblings are sorted together by these keys, and
recursion into a subdirectory happens exactly when the merge reaches that directory's _marker_
position, not when it reaches the bare-path entry. This correctly interleaves a subdirectory's entire
descendant set among its siblings, matching what a flat `ORDER BY path` over all the resulting path
strings would produce. `test/unit/fs/walker.test.ts` exercises exactly the `a`/`a!`/`a.txt`/`a/b.txt`/`ab`
case above as a regression test.

## Why writes are deferred to a second pass

Both sides of the merge-join (`iterateAllSortedByPath()` on the walker's output and on `cache.db`) are
**keyset-paginated** (`src/db/keyset-pagination.ts`), not a live `.iterate()` cursor — each page is a
plain `.all()` that runs to completion and frees the connection before any of its rows are yielded, so
a write (`cacheRepo.upsert()`) could actually interleave safely with the comparison loop as far as
`better-sqlite3` is concerned (a write only ever conflicts with _another_ statement's cursor left
_paused_ mid-generator, which pagination never does — see
[concurrency-and-progress.md](concurrency-and-progress.md) for the precise, empirically-verified
constraint).

Writes are still staged into a temp table and applied in a second pass regardless, but for a different
reason: case-collision detection (see
[cross-platform-filesystem.md](cross-platform-filesystem.md)) needs to see the **whole** decided batch
before any row is safely committed to `cache.db` — a row later found to collide must never have been
written at all, and undoing an already-written row by deleting it would be wrong for a _modified_ row
specifically (it would erase pre-existing content rather than reverting to it). The staging table
itself is bounded by how much actually _changed_, not by the size of the tree, and is itself
keyset-paginated when read back — a scan over a huge, mostly-untouched library still only buffers a
handful of rows, never the whole `cache.db` table.

## Writes are batched, and pragmas are tuned by durability tier

A first-ever scan of a large, previously-untracked tree stages and applies one row per changed
path — 54,529 of each on the real vault's initial run — and until this was fixed, each `insert()`/
`upsert()` was its own implicit transaction: roughly 109,000 separate fsyncing commits, interleaved
with the sequential reads hashing does. Measured synthetically (20,100 rows, same physical filesystem
class as the real vault's `.sync1/`): ~80s unbatched vs. ~3s batched, about 27x.

Both `StagingRepository.insert()` and the cache-apply loop in `performUpdateCache` now buffer rows and
commit them via `db.transaction()` in chunks of 500 — small enough that a crash mid-scan only redoes a
few hundred rows' worth of work (the staging table is thrown away in a `finally` regardless; a crash
mid-apply-loop just means the next `update_cache` re-derives the same rows from a merge-join against
whatever _did_ land in `cache.db`), large enough that ~109,000 commits becomes ~200. Staging batches
internally, transparently — `insert()` is called from five different branches scattered through the
merge-join, so every read method (`iterateAll`, `isDeletedInBatch`, `liveCollisionGroups`,
`liveRowsForNormalizedPath`) flushes the buffer first, making the batching invisible to callers.
`cache.db`'s apply loop is a single, contained loop instead, so it batches explicitly via a
`CacheEntriesRepository.transaction()` escape hatch rather than teaching `upsert()` itself to buffer —
`upsert()`/`delete()` are called from many other, less predictable call sites across the codebase
(`materialize`, `stubify`, `apply-remote-changes`, …), where an interleaved read expecting to see its
own just-written row would silently see stale data if buffering were the default there too.

`synchronous` is set per database by how expendable its writes are, not uniformly:

- **`cache.db`**: `NORMAL`. Fully regenerable from the filesystem by a fresh `update_cache` — losing
  the last few fsyncs to a crash costs a rescan of a handful of paths, not real data.
- **the staging DB**: `OFF`. Deleted in a `finally` every run, successful or not — there is nothing to
  protect against a crash losing its fsyncs, since the whole file is thrown away either way.
- **`state.db`**: `FULL`, explicitly (the pre-existing default, made explicit rather than changed). The
  one durable database — synced to S3, the source every machine reconstructs from — and its writes are
  rare (once per commit), so the cost buys real safety at essentially no price.

All three, plus a shared `openStateDbReadOnly`/`openCacheDbReadOnly` opener now used by the ~11 call
sites that previously opened a raw read-only `better-sqlite3` handle directly (bypassing pragmas
entirely), also get `temp_store = MEMORY`, a larger `cache_size`, and a `busy_timeout`. Every prepared
statement in `CacheEntriesRepository`/`StagingRepository` is now cached at construction rather than
recompiled on every call — better-sqlite3 does not do this on its own.

## Directories carry no content

A directory's cache row always has `hash = null` and is never rehashed (there's nothing to hash) —
existence is the only signal. If a directory reappears after being marked `deleted`, that's treated as
a fresh `created`, mirroring how a recreated file is handled, rather than as some kind of directory
"modification" (which wouldn't mean anything without content).

## Pending changes are never downgraded mid-flight

If a path's cache row is already `created` or `modified` (detected by an earlier `update_cache` run,
not yet folded into a `sync` commit) and the file changes _again_ before `sync` runs, `update_cache`
keeps it in that same category and preserves its original `parent_state_version` baseline — it only
refreshes the recorded hash/mtime. Only an actual `sync` commit ever clears a row back to `unchanged`;
`update_cache` alone never does, since doing so would erase evidence of an uncommitted local change.

The baseline is preserved more broadly than that, though: an `unchanged` row going `deleted` or
`modified` carries its existing `parent_state_version` over too. Dirtying a file doesn't change which
vault version the change is based on, and `update_cache` has no business re-stamping it from the run's
`last_synced_version` — see [conflict-resolution.md](conflict-resolution.md)'s invariant section for
why the global pointer and a path's own vault stamp are different numbers. The one row that genuinely
takes `last_synced_version` is a brand-new `created` path: there's no vault row for it to mirror yet.

`update_cache`'s reported counts follow the same "what did this scan actually do" rule throughout: a
path that is already a `deleted` tombstone from a prior run is a no-op, and is not re-counted as a
deletion on every subsequent scan.
