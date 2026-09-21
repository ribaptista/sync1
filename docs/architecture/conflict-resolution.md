# Conflict resolution

## The mental model: optimistic concurrency, like `git push --ff-only`

Every commit to state.db is serialized through a single CAS-guarded pointer (`/current`), so there's a
strict total order of versions regardless of how many machines are involved. Each cache row tracks
`parent_state_version` — the version this machine's pending local change is relative to. Deciding
whether a local change can be applied cleanly is then: "has state.db moved past my baseline for this
path, and if so, did it move to the exact same place I'm trying to move it, or somewhere genuinely
different?" That's the same shape as `git push` being rejected as non-fast-forward, and a conflicted
merge needing a human to resolve it — not a novel mechanism, just applied per-path instead of per-repo.

## The invariant: `parent_state_version` is per-path, never a commit-level value

Everything below depends on one rule holding at every single site that writes a cache row:

> `cache[path].parent_state_version` is always a copy of `entries[path].state_version` — the version at
> which **that path's own row** was last written in the vault. It is never the version of whatever
> commit happened to be in flight, and never this machine's `last_synced_version`.

The reason is simply that it is _compared_ against `entries[path].state_version` for the same path (the
`state_version === parent_state_version` checks in the matrix below). Anything else is comparing two
different kinds of number.

The temptation is to treat "the version this machine last synced at" as good enough, because for a
while it is: if `sync` is the only thing ever minting versions, and every commit rewrites every dirty
path, the global and per-path numbers move in lockstep. Neither premise holds:

- **Policy mutations mint versions without touching `entries` at all.** `ignore`, `storage_policy` and
  `thumbnail_policy` edits all commit through `src/sync/mutate-state-db.ts`, which creates a new version
  and advances `.sync1/last_synced_version` while every `entries` row keeps the stamp it already had.
  One policy edit is enough to put the global pointer permanently ahead of every path in the vault.
- **A commit doesn't rewrite the paths it merely pulled down.** A sync that commits this machine's own
  edit to one path while pulling another machine's change down for a different path leaves the second
  path's vault row at the _other_ machine's version, not this commit's.

Once the two numbers drift apart, every subsequently deleted or modified path is compared against a
baseline that has nothing to do with it, and the matrix's version check fails for reasons that have
nothing to do with what actually happened — producing a stream of false
`"was deleted locally, but modified remotely"` conflicts on a vault only one machine has ever touched.
This was a real bug; `test/e2e/sync_version_stamp_drift.test.ts` reproduces both routes to it.

Concretely, that means:

| Writing a cache row because…                                        | the stamp to write is                                                                                                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| a path was pulled down from the vault (`apply-remote-changes.ts`)   | that entry's own `state_version`                                                                                                               |
| a scan found a path locally deleted or modified (`update-cache.ts`) | the row's existing stamp, carried over unchanged — dirtying a file doesn't change which vault version the change is based on                   |
| a scan found a brand-new path (`update-cache.ts`)                   | `last_synced_version` — the one legitimate use: there is no vault row to mirror yet, and `created` rows are resolved by hash, never by version |
| a commit applied the row (`reconcile-cache.ts`)                     | the new commit's stamp — it was just written into `entries` with exactly that                                                                  |
| a commit resolved the row as a **no-op** (`reconcile-cache.ts`)     | the stamp the vault already held, since a no-op writes nothing to `entries`                                                                    |

The last two are why `applyLocalChangesToCandidate` reports a path → stamp map (`HandledPathStamps`)
rather than just the set of paths it handled: only it knows, per row, which of those two cases applied.

## The full matrix (`src/sync/conflict-rules.ts`)

Pure, exhaustively unit-tested decision logic — given a locally-dirty cache row and whatever entry (if
any) currently exists in state.db for that path:

**created** (no prior entry existed as far as this machine knew):

- No entry exists remotely → apply. This covers both "genuinely new" and "existed, then was deleted
  remotely" identically, because deletions are full row removals (no tombstones) — there's no way to
  distinguish those two cases from state.db's point of view, and there's no need to.
- An entry exists with the same hash → no-op (recoverable: e.g. two machines independently created
  identical content).
- An entry exists with a different hash → conflict.

**modified** (this machine's baseline was some earlier version):

- No entry exists remotely → conflict (can't have been "modified from" something that's gone; the
  remote side deleted a path this machine was editing).
- The entry's `state_version` matches this row's `parent_state_version` → apply (fast-forward: nothing
  changed remotely since this machine's baseline).
- The entry's `state_version` differs but its hash matches this row's hash → no-op (remote moved on, but
  independently ended up at the exact same content).
- Otherwise → conflict.

**deleted**:

- No entry exists remotely → no-op (both sides already agree it's gone).
- The entry's `state_version` matches this row's `parent_state_version` → apply.
- Otherwise → conflict (remote modified the path after this machine's baseline, before deleting it
  locally).

## `entry_deletions`: an audit trail for a decision this design makes deliberately lossy

A deletion is a full row removal, not a tombstone (see above) — deliberate, not an oversight: it's what
lets "created, no entry exists remotely" cover both "genuinely new" and "existed, then was deleted
remotely" identically, with no third state for every other decision in the matrix to account for. The
cost is that once a path's `entries` row is gone, nothing in the live vault says it ever existed at all —
once `gc` later collects the now-unreferenced object, there's no way to answer "what happened to this
file, and when?" from the vault itself.

`entry_deletions` (migration 0010) is a write-only audit table that answers exactly that question,
without touching sync semantics at all: nothing in the conflict matrix, `decideLocalChange`, or any other
sync logic ever reads it. `EntriesRepository.deleteWithHistory(entry, deletedInVersion)` — the sole
replacement for a plain `delete`, with exactly one call site (`apply-local-changes.ts`'s Pass 1, the only
place in the whole tree that removes an `entries` row) — wraps the `entries` `DELETE` and the
`entry_deletions` `INSERT` in one transaction, recording the path, type, the deleted content's hash (`NULL`
for a directory), and **both** version stamps: `introduced_in_version` (the entry's own `state_version` at
the moment it was fetched, i.e. the commit that last wrote it) and `deleted_in_version` (the commit doing
the removing, a parameter already in scope at the one call site — both cost zero extra queries).

`hash` deliberately has **no** foreign key to `objects`, unlike `entries.hash` — the asymmetry matters.
`gc`'s own orphan anti-join (`objects-repository.ts`) is written against `entries` _literally_
(`WHERE hash NOT IN (SELECT DISTINCT hash FROM entries WHERE hash IS NOT NULL)`), not via generic
reference discovery, so a row in `entry_deletions` can never accidentally pin content the vault no longer
references — an object is still correctly collected once its last `entries` reference is gone, even
though a history row naming its hash remains. That's also exactly why an FK on `hash` would be actively
dangerous rather than merely redundant: state.db opens with `foreign_keys = ON`, so it would make
`gc --apply` fail outright with a constraint violation the moment it tried to delete an object a history
row still named. The two version-stamp columns _do_ carry FKs (`REFERENCES versions (version_stamp)`) —
safe today, since nothing anywhere deletes from `versions`, and worth having to catch a bogus stamp; this
does mean `entry_deletions` quietly commits the schema to never pruning `versions` while it stays FK'd.

Two things worth stating plainly so the table isn't over-read at audit time: a **rename** (there's no
rename primitive anywhere in this system — `update_cache` resolves one as an independent delete + create)
shows up here as an ordinary deletion, recoverable only by an audit-time query over data already stored
(a deletion row whose `hash` matches a path _created_ in the same `deleted_in_version`); an **overwrite**
(a path's row replaced via `upsert`, e.g. a file↔dir type change) never passes through `delete` at all, so
it leaves no row here — this logs rows removed from `entries`, not every way a path's content stopped
being reachable.

Growth is unbounded by design — there's no retention policy, and none is planned. The cost is paid
repeatedly, not once: the candidate state.db is what gets encrypted and uploaded as every future
`/states/<version>` snapshot, so these rows ride along in every one of them from the commit that wrote
them onward. Deletions are rare relative to file count in ordinary use; the pathological case is removing
a very large tree in one commit.

## The no-op leniency rules are also what makes crash recovery self-heal

The "same hash despite version mismatch" and "already gone" no-op rules aren't just about two machines
independently converging — they're structurally what makes a _half-finished commit_ on the same machine
safe to retry. If `sync` crashes after the CAS write to `/current` succeeds but before `cache.db` gets
reconciled back to `unchanged`, the next `sync` attempt re-evaluates that still-dirty row against
state.db — which, by now, already reflects this exact same machine's own prior commit. For a
`created`/`modified` row, the hash matches (it's the content this machine itself just wrote) → no-op.
For a `deleted` row, the entry is already gone (this machine's own prior commit removed it) → no-op.
Either way, the row gets reconciled correctly on the next attempt with no special-case recovery code —
see `test/unit/sync/conflict-rules.test.ts`'s "crash-recovery self-healing" tests and
`test/e2e/sync_bidirectional.test.ts`'s equivalent end-to-end case.

## Partial success, not all-or-nothing

A single conflicting path does not block every other change in the same `sync` run. Every dirty row is
evaluated independently; whatever doesn't conflict is folded into the new version and committed, and
only the genuinely conflicting paths are reported and left dirty for manual resolution. This matches
`git`'s behavior more than a strict two-phase-commit would: an unrelated conflict elsewhere in the tree
doesn't stop you from getting today's other changes backed up.

A row whose upload genuinely _fails_ (not a conflict -- the content was never applied at all) gets the
same treatment, for the same reason: `applyLocalChangesToCandidate`'s dispatched job catches it, marks
neither `handledPaths` nor `appliedCount` for any row riding on that job (the dispatcher and any
same-batch dedup attach alike), and leaves every one of them dirty. The candidate DB never learns about
the failed content at all -- no `entries`/`objects` row is written for it -- so the run's other,
unrelated successes still land in the new version, and the failed path is simply retried on the next
`sync`. See `src/progress-types.ts`'s `FileTracker.abort()` for the matching progress-accounting half:
a failed file must not be reported as transferred either.

## What decides whether a new version gets created at all

Not "were there dirty rows" — a dirty row might resolve as a no-op (nothing to write) or a conflict
(deliberately not written). A new version is only created and uploaded when at least one row actually
produced a real state.db mutation (`appliedCount > 0`, tracked separately from "handled" which includes
no-ops). If nothing needs writing, `sync` still pulls down any genuine remote-only changes and advances
the local baseline to match — that's an adoption of already-existing state, not a new commit, so there's
nothing to upload and no CAS write to attempt.

## Determining what needs to be pulled down: diff cache.db against the candidate, not two state.db snapshots by version

The first implementation compared "the local state.db snapshot before this sync" against "the freshly
fetched remote snapshot" to find remote-only changes, gated on whether `/current`'s version stamp had
changed since this machine's last sync. That's wrong, and a concrete scenario proves it: right after
`attach_remote`, local state.db is already fully populated (it was just fetched) while `cache.db` is
completely empty (nothing has been materialized onto the filesystem yet). The version stamp comparison
says "nothing changed" (true — nothing changed _since attach_), while in reality _everything_ still
needs to be downloaded.

The fix: diff `cache.db`'s actual current content directly against the candidate state.db (which by
that point already reflects remote's latest plus this machine's own successfully-applied local edits),
comparing hashes per path — not comparing two state.db snapshots against each other by version stamp.
This is correct regardless of _why_ cache.db and state.db diverged (a fresh attach, another machine's
commits, or anything else), because it asks the only question that actually matters: does what's
locally materialized match what state.db says should be there. `applyRemoteChangesToLocal` uses a
second, read-only connection to `cache.db` for this comparison so it can iterate it while the
caller's own connection is used to write the results back.

## CAS failure: no auto-retry

If the conditional write to `/current` fails (another machine committed first), `sync` fails the whole
attempt with a clear error asking the user to run `sync` again — it does not automatically refetch and
retry. Unlike `gc`'s internal retry (Task 13; safe because removing orphans is a pure recomputation with
no human judgment involved), a `sync` conflict may need a real decision about which side's content
should win, so silently retrying could paper over something the user needs to see.
