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
[the README's "Glob syntax" section](../README.md#glob-syntax) for the full dialect). Two call
sites check a path against every ignore policy: `update_cache`'s merge-join (local creations) and
`apply-remote-changes.ts`'s merge-join (remote arrivals) — both preload the (expected-small) policy list
once via `IgnorePoliciesRepository.listGlobs()` before the loop starts, rather than re-querying it per
path, since one side of each merge-join (a filesystem walk) was never SQL rows to begin with.

## What matching actually gates

- **New local creation** (`update_cache`): a match means the path is skipped entirely — not staged into
  `cache.db` at all, not even as a rejected/reported row (unlike a case collision). Just a debug log and
  a summary count (`stats.ignored`).
- **New remote arrival** (`apply-remote-changes.ts`): a match does **not** block materialization. Ignore
  policies gate new local creations from ever entering the vault — they never retroactively un-share
  content some other machine already committed. This situation can only arise from a timing/history
  quirk (the content was committed before the policy existed, or before this machine had synced the
  policy), so it's surfaced as a warning (`ignoredButSynced` / `sync`'s `ignored_but_synced` output field)
  rather than a failure — it never changes `sync`'s exit code.

## `sanity_check`'s relationship to ignore policies

`sanity_check` (`src/fs/sanity-check.ts`) is a read-only diagnostic, never a repair tool — it exists so
bugs can be found rather than silently worked around. It reuses the same `matchesAnyGlob` matching
utility to distinguish an untracked-and-ignored local file (expected, not a problem, just counted via
`ignoredCount`) from a genuinely untracked one (`untracked`, worth investigating). Unlike
`update_cache`/`materialize`, which auto-clean a dangling stub (both a stub and a real file present for
the same path) by treating the real file as canonical, `sanity_check` always reports that state
(`bothStubAndReal`) without touching either file — a state that's normally silently self-healed elsewhere
is exactly the kind of thing worth surfacing in a bug-finding tool.
