# Garbage collection scope

## Current-state-only, on purpose

Every `/states/<version_stamp>` snapshot is kept forever (see
[vault-and-encryption.md](vault-and-encryption.md)), which is what gives point-in-time history for
free — you can inspect an old snapshot's metadata (paths, hashes, when they changed) at any past
version. `gc` doesn't touch that history. It only removes an object's actual bytes once **no path in
the current live state** references its hash anymore.

This is a deliberate, accepted tradeoff, not an oversight: an old snapshot might still list a hash that
`gc` has since removed the bytes for. Its metadata stays inspectable forever — you can still see that a
file existed there, with that hash, at that version — but its content becomes permanently
unrecoverable once `gc --apply` removes the last reference. There's no way to fully preserve both "keep
every version forever" and "actually reclaim storage for deleted files," since the entire point of
keeping every version is that old versions remember things the current version has forgotten. Given
`gc` is explicitly for reclaiming storage — usually the bulk of a personal backup's cost, since
metadata itself is tiny — current-state-only scope is the only choice that does what it's for.

## Why the CAS-conflict retry is safe here but not in `sync`

`sync` refuses to auto-retry a CAS conflict against `/current` because resolving it might require an
actual human decision (whose edit wins, an edited-vs-deleted conflict, and so on) — see
[conflict-resolution.md](conflict-resolution.md). `gc` has no such ambiguity: "which hashes are
referenced by the current live state" is a pure function of whatever `/current` happens to point at, at
any given moment. If another machine commits between `gc`'s read and its own CAS attempt, refetching
and recomputing from the new `/current` always produces a correct answer with nothing for a person to
decide — so retrying automatically (bounded to a handful of attempts, as a safety net against a
pathological run of concurrent commits) is strictly safe, and friendlier than making the user re-run the
command by hand for no real reason.

## Testing the retry deterministically

Racing two independent CLI processes against a real (if fast) LocalStack backend has no reliable window
to land a competing commit inside — by the time a second process could plausibly interleave, the first
has usually already finished. `performGc` exposes a test-only seam, `onBeforeCas`, called immediately
before each CAS attempt; `test/e2e/gc_retry.test.ts` uses it to inject a real competing commit from a
second machine at exactly that point, forcing the first CAS attempt to fail against a now-stale etag and
proving the refetch-and-recompute path actually runs — a successful result is itself the proof, since
without the retry logic the stale-etag CAS attempt would have thrown instead of succeeding.
