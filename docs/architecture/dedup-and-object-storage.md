# Content-addressed dedup and object storage

## The `objects` table

state.db's `objects` table (`hash` PK, `s3_key`, `size`) is the single source of truth for "has this
exact content already been backed up." `entries.hash` references it — multiple paths can point at the
same object row, which is exactly how dedup works: two files with byte-identical content end up as two
`entries` rows referencing one `objects` row, with only one upload ever happening.

Because content encryption is convergent (same plaintext + same content-hash context always produces
byte-identical ciphertext — see
[vault-and-encryption.md](vault-and-encryption.md)), the dedup check never has to compare plaintext or
download anything to decide whether an upload is needed: `objectsRepo.has(hash)` against the local,
already-decrypted state.db is enough.

## Upload-before-reference, always

For every dirty cache row being folded into a sync, `applyLocalChangesToCandidate` does, in order:

1. Check `objects` for the hash. If present, skip the upload entirely (the dedup path).
2. If absent: read the file, encrypt it, upload it to `objects/<hash>`, **then** insert its `objects`
   row.
3. Only then insert/update the `entries` row that references that hash.

This ordering means a crash between steps 2 and 3 leaves an uploaded-but-unreferenced object — wasted
space, never a dangling reference to bytes that don't exist. The next sync attempt just re-discovers
the local change (cache.db still shows it dirty) and re-checks `objects` for the hash; worst case it
re-uploads once more.

## A real bug this ordering exposed: versions before entries

`entries.state_version` is a foreign key into `versions.version_stamp` — so the new version's row must
exist in the candidate database _before_ any entry can reference it, not after. The first
implementation got this backwards (inserting the `versions` row only after looping over every dirty
row), which meant the very first `entries` upsert of a sync failed with a FOREIGN KEY constraint error.
Fixed by inserting the `versions` row first, before processing any dirty rows. Worth calling out
explicitly since it's the kind of ordering mistake that only surfaces once there's real data flowing
through — the unit tests for the repositories individually didn't catch it because they never exercised
this specific sequencing.

## Candidate database, promoted only after the remote commit succeeds

`sync` never mutates the live local `state.db` directly. It copies it to a candidate file, applies all
changes there, uploads the candidate (encrypted) to `states/<version_stamp>`, and only attempts the
CAS-guarded `/current` write after that upload succeeds. The candidate file is only renamed over the
real `state.db` — and only then are `last_synced_version` updated and cache.db rows reconciled — after
the CAS write itself succeeds. Any failure at any point before that leaves the local `state.db` and
`cache.db` completely untouched, so retrying is always safe: nothing needs to be rolled back, because
nothing durable was changed.
