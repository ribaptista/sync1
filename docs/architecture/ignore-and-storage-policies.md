# Ignore policies (and sanity_check)

## Global, not per-machine

Ignore policies (`ignore` command, `ignore_policies` table) live in `state.db` — shared and versioned
across every machine backing up the same vault — not in `cache.db`, which is local and unencrypted per
machine. The reasoning is the same as for storage-class policies (a planned sibling feature, its own
future doc): an ignore rule decides what's allowed to enter the shared vault at all, so every machine
needs to agree on the same rules. A local-only ignore mechanism would let two machines disagree about
whether a given path should ever be backed up, which is a much worse failure mode than the minor
inconvenience of needing the vault password to change the rules.

Reading the policy list needs no password — `state.db` sits fully decrypted on disk once synced, same as
`objects`/`entries` — but creating, editing, or deleting a policy is a real commit (new version,
uploaded, CAS'd against `/current`), using the same generic `mutateStateDb` helper storage-class policies
also use. See `src/sync/mutate-state-db.ts`.

## No priority, unlike storage-class policies

Ignore policies are a monotonic OR: any matching glob pattern means the path is ignored, full stop.
There's no precedence/priority column, because there's no conflict to resolve — two overlapping ignore
patterns matching the same path agree with each other by construction (both say "ignore it"). This is
what keeps `ignore` a much simpler CRUD than storage-class policies, which fundamentally need an explicit
priority to decide between overlapping globs implying _different_ target classes.

## Why matching happens in memory

No call site anywhere in this codebase uses SQL `GLOB` — every glob match, for every command and every
policy type, happens in memory via `matchesAnyGlob` (`src/fs/glob-match.ts`, wrapping `minimatch`; see
[the README's "Glob syntax" section](../README.md#glob-syntax) for the full dialect). Three call
sites check a path against every ignore policy: `update_cache`'s merge-join (local creations),
`apply-remote-changes.ts`'s merge-join (remote arrivals), and `scanThumbnails`'s own walk
(`src/fs/thumbnail.ts` — see below) — all three preload the (expected-small) policy list once via
`IgnorePoliciesRepository.listGlobs()` before the loop starts, rather than re-querying it per path, since
one side of each walk/merge-join (a filesystem walk) was never SQL rows to begin with. `sanity_check`
reuses the same `matchesAnyGlob` utility too, for its own read-only diagnostic purpose — see its own
section below.

## What matching actually gates

- **New local creation** (`update_cache`): a match means the path is skipped entirely — not staged into
  `cache.db` at all, not even as a rejected/reported row (unlike a case collision). Just a debug log and
  a summary count (`stats.ignored`).
- **An uncommitted local creation already in `cache.db`** (`update_cache`): the same merge-join's other
  branch, for a path the _previous_ scan already staged as `state === 'created'` — never synced, so
  nothing else has ever seen it. A policy created _after_ that discovery now matching it drops the row
  (`cacheRepo.delete`, not a `'deleted'` tombstone — a tombstone would propagate as a delete on the next
  sync, which is not what happened) rather than leaving it to be uploaded on the next `sync`. Reported by
  path, not just counted (`stats.droppedIgnored`, threaded through into `sync`'s own
  `dropped_ignored` output field) — unlike a brand-new ignored path, this is content the user might
  reasonably have expected was already on its way into the vault, so which paths were dropped matters.

  Deliberately narrower than "any dirty row": a **committed** row (`'unchanged'`/`'modified'`) is never
  dropped this way, no matter what policy shows up later. An ignore policy gates what's allowed to
  _start_ entering the shared vault — it never retroactively un-tracks content already there, because a
  local-only removal of an already-shared path's cache row is indistinguishable from a local delete, and
  would propagate as one to every other machine on the next sync. (Un-sharing already-committed content
  on purpose is a different, deliberate operation — `stubify`/removing the path outright — not a side
  effect of adding an ignore rule.)

- **New remote arrival** (`apply-remote-changes.ts`): a match does **not** block materialization. Ignore
  policies gate new local creations from ever entering the vault — they never retroactively un-share
  content some other machine already committed. This situation can only arise from a timing/history
  quirk (the content was committed before the policy existed, or before this machine had synced the
  policy), so it's surfaced as a warning (`ignoredButSynced` / `sync`'s `ignored_but_synced` output field)
  rather than a failure — it never changes `sync`'s exit code.

- **Thumbnail candidate** (`scanThumbnails`, `sync1 thumbnail state/ensure/cleanup`): a match means the
  path is skipped entirely — never probed, never policy-resolved, exactly as if it matched no
  `thumbnail_policy` glob at all. Deliberately unconditional, unlike `update_cache`'s own
  "only an uncommitted row" carve-out above: a thumbnail is a local-only artifact with no cross-machine
  propagation concern, so there's no reason to spare an already-thumbnailed path once its glob becomes
  ignored. Nothing deletes its existing thumbnail directly either — it's simply never claimed by this
  scan, so it falls through the ordinary unclaimed-orphan sweep (`toDelete`) like any other orphaned
  thumbnail. See [thumbnails.md](thumbnails.md#thumbnail_policy-deciding-what-gets-a-thumbnail).

Since `sync` runs `performUpdateCache` internally as its own first phase, both local-creation cases
above take effect identically whether the scan runs via the standalone `update_cache` command or as part
of a full `sync` — there is no separate code path to keep in sync (no pun intended).

## `sanity_check`'s relationship to ignore policies

`sanity_check` (`src/fs/sanity-check.ts`) is a read-only diagnostic, never a repair tool — it exists so
bugs can be found rather than silently worked around. It reuses the same `matchesAnyGlob` matching
utility to distinguish an untracked-and-ignored local file (expected, not a problem, just counted via
`ignoredCount`) from a genuinely untracked one (`untracked`, worth investigating). Unlike
`update_cache`/`materialize`, which auto-clean a dangling stub (both a stub and a real file present for
the same path) by treating the real file as canonical, `sanity_check` always reports that state
(`bothStubAndReal`) without touching either file — a state that's normally silently self-healed elsewhere
is exactly the kind of thing worth surfacing in a bug-finding tool.
