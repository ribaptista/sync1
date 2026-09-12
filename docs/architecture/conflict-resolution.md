# Conflict resolution

## The mental model: optimistic concurrency, like `git push --ff-only`

Every commit to state.db is serialized through a single CAS-guarded pointer (`/current`), so there's a
strict total order of versions regardless of how many machines are involved. Each cache row tracks
`parent_state_version` — the version this machine's pending local change is relative to. Deciding
whether a local change can be applied cleanly is then: "has state.db moved past my baseline for this
path, and if so, did it move to the exact same place I'm trying to move it, or somewhere genuinely
different?" That's the same shape as `git push` being rejected as non-fast-forward, and a conflicted
merge needing a human to resolve it — not a novel mechanism, just applied per-path instead of per-repo.

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
