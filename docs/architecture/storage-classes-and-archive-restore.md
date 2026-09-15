# Storage classes and archive/restore

## Why only three classes

`STANDARD` (immediate access), `GLACIER` (cold, needs a restore, ~hours), `DEEP_ARCHIVE` (coldest,
needs a restore, ~half a day to two days) — deliberately not the full set of S3 storage classes (no
`STANDARD_IA`, `GLACIER_IR`, `INTELLIGENT_TIERING`, etc.). This gives exactly "immediate + two cold
tiers with a meaningful cost/latency split between them," which is what a personal backup tool actually
needs — an instant-but-cheap tier (`GLACIER_IR`) was considered and deliberately left out to keep the
restore-dance logic covering only two classes instead of three.

## The shared primitive: classifying archive status from a HEAD response

`classifyArchiveStatus` (`src/s3/archive-status.ts`) takes just `StorageClass` and the `x-amz-restore`
header from a HEAD response and returns one of five states:

- `immediate` — not a cold class at all.
- `needs-restore-request` — cold, no restore ever requested (or the header is simply absent).
- `restore-ongoing` — cold, `ongoing-request="true"`.
- `restore-ready` — cold, `ongoing-request="false"`, and the parsed `expiry-date` hasn't passed yet.
- `restore-expired-needs-reissue` — cold, restore completed, but the temporary copy's expiry date has
  already passed — treated the same as never having requested one.

This is pure and takes no I/O, which matters because LocalStack does not simulate real Glacier/Deep
Archive restore timing — it accepts the API calls but won't actually make a `restore-ongoing` object
transition to `restore-ready` after some realistic delay. So the state machine itself is covered by
direct unit tests against fabricated HEAD responses (`test/unit/s3/archive-status.test.ts`), and e2e
tests are limited to what's actually observable against LocalStack: the immediate (non-restore) path
end-to-end, and that the correct API calls get issued for the warmer/restore path without erroring.

## Two consumers, one primitive, different decisions

`decideStorageClassAction` (`src/s3/storage-class-actions.ts`) is `status`/`converge`'s decision layer
on top of `classifyArchiveStatus` — it also knows the _target_ class (resolved per object from
`storage_policy`'s rules, see [storage-class-policies.md](storage-class-policies.md)), so it can tell
"colder target, always immediate" apart from "warmer target, follow the restore dance." `materialize`
uses `classifyArchiveStatus` directly instead, with a simpler question: "can I read this content right
now, or do I need to ask for temporary access first" — it has no target-class concept, since
materializing never changes an object's permanent storage class.

## Colder is a plain copy; warmer is two-phase

S3 has no direct "set storage class" API — the standard mechanism is a same-bucket, same-key
`CopyObject` naming the new `StorageClass`, which `copyObjectStorageClass` wraps. Moving to a colder
class is always exactly that one call. Moving to a warmer class needs `RestoreObject` first (to get a
temporary readable copy off the archived original) and only _then_ the same finalizing copy, once the
restore is `ready` — the copy is what actually, permanently changes the class; a completed restore by
itself does not.

## Dedup interaction

`status`/`converge` resolve `--filter` against **distinct content hashes**
(`EntriesRepository.iterateDistinctHashesMatchingGlob`), not paths — matched in memory via `matchesAnyGlob`
(see [ignore-and-storage-policies.md](ignore-and-storage-policies.md)) over a `path`-ordered,
literal-prefix-seeded scan of `entries` (`src/db/glob-scan.ts`), deduped into distinct hashes via an
in-memory `Set` as the scan runs. Since storage
class is a property of the object, not any individual path, its resolved target affects every path that
references that hash, including ones outside `--filter`'s scope, if they happen to share identical
content. Unlike the single-glob-target model this replaced (the removed `ensure_storage_class`, where
every matched path always implied the same target), `storage_policy` lets different paths imply
_different_ target classes for the very same shared object — see
[storage-class-policies.md](storage-class-policies.md) for how that's resolved (warmest wins, with the
disagreement surfaced rather than silently picked).
