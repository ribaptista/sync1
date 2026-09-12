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

`better-sqlite3` refuses to run another statement on a connection while a `.iterate()` cursor from
that same connection is still open — so `cacheRepo.upsert()` can't be called in the middle of the
merge-join loop while `iterateAllSortedByPath()`'s cursor is active. `performUpdateCache` handles this
by building up a small array of pending row writes during the (read-only) comparison loop, and only
applying them via `cacheRepo.upsert()` after that loop finishes and the cursor is exhausted. This still
honors "don't load the full dataset into memory" in the sense that matters: the pending-writes array is
bounded by how much actually _changed_, not by the size of the tree — scanning a huge, mostly-untouched
library still only buffers a handful of rows, not the whole cache.db table.

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
