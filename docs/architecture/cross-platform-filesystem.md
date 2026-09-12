# Cross-platform filesystem support

sync1 was built and tested only on Linux (ext4, case-sensitive). Windows and default macOS (APFS/HFS+)
filesystems are case-_insensitive_ but case-_preserving_ — two paths differing only by case (e.g.
`Photo.jpg`/`photo.jpg`) refer to the same real file there, but are two distinct rows in both cache.db
and state.db, which never treat paths as anything but exact strings. Left unguarded, this would let two
machines (or one machine at two different times) silently clobber each other's content. This doc covers
how that's prevented.

## The invariant

At any point in time, cache.db's _live_ (non-tombstoned) rows are pairwise distinct when compared
case-insensitively, and so are state.db's entries (which have no tombstones at all — a deleted entry is
a removed row). Two checkpoints enforce this, one per side of the sync boundary:

## Checkpoint 1: local scan (`update_cache`)

Implemented in `src/fs/update-cache.ts`, right before update_cache's staged batch (see
`docs/architecture/cache-and-filesystem-scanning.md` for the staging design generally) gets applied to
cache.db. For every normalized-path group with more than one currently-_live_ row — checked both within
the batch itself (two paths newly staged as live at once) and against cache.db's existing durable rows
(a newly-staged path colliding with something already tracked from an earlier scan) — every row in the
group is left unapplied, reported in the result's `caseCollisions` field, and update_cache exits non-zero.
Crucially, this is **not a thrown exception**: every other row in the batch that doesn't collide still
gets applied normally. A single naming mistake anywhere in a large tree never blocks the rest of that
scan from being recorded.

An earlier draft of this also had a same-directory pre-check in the filesystem walker itself, purely to
fail fast before the whole tree was walked and hashed. It was dropped: since nothing computed by a run
containing a collision is ever wasted (everything else still gets applied), there's no "abort early to
avoid redoing work" case left to optimize for — the tree gets walked and hashed exactly once either way,
and a rerun only ever needs to re-walk (cheap `stat` calls), never rehash, whatever didn't collide.

### The tombstone-exclusion rule, and why it's the whole point

`findByNormalizedPath` (on both `CacheEntriesRepository` and `EntriesRepository`) only ever matches a
currently-_live_ row. For cache.db that means filtering out `state = 'deleted'` rows. This matters because
update_cache always resolves a rename as an independent delete-plus-create — there's no rename primitive
anywhere in this system — so renaming `file.txt` to `FILE.txt` looks, to update_cache, identical to
deleting an unrelated `file.txt` and creating an unrelated `FILE.txt` in the same run. Without excluding
tombstones, that would look like a collision every time, since the old path's tombstone is still sitting
in cache.db at the moment the new path is checked. With it, the ordinary recovery path — **delete or
rename one of the two colliding paths, then run `update_cache` (or `sync`, which runs it first) once** —
succeeds in a single pass: the vanished path's tombstone and the surviving path's creation land in the
same batch, and the tombstone-exclusion rule means the survivor isn't blocked by its own former self.

### A performance index detail worth knowing

`normalized_path` is a real, separately-indexed column (`0002_add_normalized_path.sql` in both cache.db
and state.db's migrations), not a `path = ? COLLATE NOCASE` query. `path`'s own index uses the default
BINARY collation, and SQLite can only use an index in the collation it was built with — a `COLLATE
NOCASE` comparison against a BINARY index forces a full table scan. A dedicated pre-lowercased column
with its own index turns the check back into an ordinary indexed lookup.

## Checkpoint 2: sync-time (`apply-local-changes.ts`)

Checkpoint 1 only ever knows about cache.db and the local filesystem — it can't see a case-variant path
some _other_ machine already committed to the shared vault. That's what this checkpoint catches: right
after `apply-local-changes.ts` looks up a dirty row's exact-path entry in the candidate state.db (the
in-progress merge of remote + this machine's own edits, about to become the new canonical version), any
row with `state === "created"` is _also_ checked against the candidate via `findByNormalizedPath`. On a
hit, it's pushed onto the same `conflicts` array the existing hash/version conflict matrix
(`conflict-rules.ts`) already uses, and skipped — exactly like any other unresolved conflict, never a
thrown error. Only `"created"` rows need this: `"modified"`/`"deleted"` target a path that already
exists at that exact spelling, so the existing exact-path conflict rules (e.g. "modified locally, but
deleted remotely") already catch those regardless of casing, for reasons that have nothing to do with
case sensitivity.

This is what actually prevents a local create from merging with an already-remote-committed case variant
and getting permanently committed — and because _every_ commit to state.db goes through this same check
against whatever version it was built from, no case-colliding pair can ever land in state.db, by
induction on version history. The practical consequence: this can never leave `sync` in a stuck,
unsolvable state. The colliding row just stays dirty (identical to any other conflict — exit code 2),
every other unrelated dirty row in the same run still commits normally, and the fix is simply renaming
or removing one of the two variants and running `sync` again.

A defense-in-depth check on the receiving side (`apply-remote-changes.ts`, when a genuinely new remote
path is about to be materialized) was considered and dropped. Given checkpoint 2 guarantees state.db can
never actually contain a colliding pair, that check should never fire in a fully-updated fleet — it was
pure insurance against a vault with collisions from before this feature existed, or a bug in checkpoint
2 itself, judged not worth the extra code path.

### An ordering bug this exposed, fixed separately

Checkpoint 2 depends on dirty rows being folded into the candidate in a specific order: every `deleted`
row before any `created`/`modified` row (`CacheEntriesRepository.iterateDirty()`'s `ORDER BY (state !=
'deleted'), path ASC`). Without it, a same-machine rename's create half could be checked against the
candidate _before_ its own delete half had been applied — and whether that happened would depend on
which way the casing sorted alphabetically (`"FILE.txt" < "file.txt"` in plain ASCII order, since
uppercase sorts before lowercase), a direction-dependent bug that's easy to miss testing only one
rename direction. `test/e2e/rename_case.test.ts` covers both.

## Known limitation

Neither checkpoint retroactively detects a collision that already exists in a vault from before this
feature was added, or one introduced by some other tool writing directly to a vault's S3 objects rather
than through sync1. Both checkpoints only ever prevent a _new_ collision from being introduced going
forward.

## A separate, Windows-only risk: transient locks on `state.db`

Unrelated to case-insensitivity, but adjacent in scope: the local `state.db` file gets renamed or
overwritten in place at a few points (`commit.ts`'s final commit and early-return-adoption paths, `gc.ts`,
`attach_remote`/`fetch_remote`'s initial writes). On Windows, an external process — most commonly an
antivirus scanner or the search indexer — can transiently hold a lock on a file that briefly blocks a
rename or open-for-write against it. Tracing every one of these call sites confirmed sync1's own process
never holds a handle on the destination at the moment of the write, so `src/fs/safe-fs.ts` wraps each of
them in a short retry-with-backoff (5 attempts, doubling from 50ms, retried only for `EBUSY`/`EPERM`/
`EACCES`) — purely a defensive measure against an external actor, not a fix to a bug in sync1's own logic.
