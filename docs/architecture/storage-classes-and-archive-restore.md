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
`CopyObject` naming the new `StorageClass`, which `copyObjectStorageClass` (`src/s3/copy-object.ts`)
wraps. Moving to a colder class is always exactly that one call. Moving to a warmer class needs
`RestoreObject` first (to get a temporary readable copy off the archived original) and only _then_ the
same finalizing copy, once the restore is `ready` — the copy is what actually, permanently changes the
class; a completed restore by itself does not.

**Above 5 GiB, that one call doesn't exist.** A single `CopyObject`'s source is capped at
`COPY_MULTIPART_THRESHOLD_BYTES` (5 GiB, S3's own `EntityTooLarge` limit) — every object larger than
that, colder or warmer alike, failed both the `immediate-copy` and `finalize-copy` paths outright until
this was fixed, which aborted the whole `converge` run (the error is fatal to the dispatched `s3Pool`
job), leaving every object after it in the run unconverged too. A `finalize-copy` failure was worse than
an `immediate-copy` one: the restore it was finishing had already been paid for, and was silently
re-requested on every subsequent `converge` run since the finalize never actually landed.

Above the threshold, `copyObjectStorageClass` does the multipart equivalent instead:
`CreateMultipartUpload` on the same key (carrying the target `StorageClass`), one `UploadPartCopy` per
~512 MiB range (each a genuinely server-side copy — no object bytes ever cross the caller's own link),
then `CompleteMultipartUpload`. `ChecksumType: "FULL_OBJECT"` throughout is what keeps the object's own
CRC64NVME identical to what it was before the copy (a composite, per-part checksum would differ purely
because the part boundaries changed, breaking every later comparison against
`objects.ciphertext_checksum`) — S3 itself verifies the combined parts against the expected value at
completion, and the result is checked again on this end
(`verifyStoredChecksum`, shared with the upload path in `src/s3/upload-object.ts`). A failure at any
point issues a best-effort `AbortMultipartUploadCommand` before rethrowing, so a failed copy never
leaves a billed, half-finished upload sitting on the object's own key.

Each object's own parts run on a queue private to that one copy call, never the caller's shared
`s3Pool` — `convergeStoragePolicies` dispatches one job per object into `s3Pool`, and that job is what
calls `copyObjectStorageClass`, so by the time a multipart copy's own parts would need pool capacity,
the job itself is already occupying a slot in the very pool it would be asking for more of. Queuing the
parts into that same pool would deadlock the run the moment enough large objects are converged at once
to fill every slot with such a job.

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
