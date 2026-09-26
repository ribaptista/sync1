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

## Object key layout: sharded, for browsability

Content objects live under a 2-level sharded prefix — `objects/<hash[0:2]>/<hash[2:4]>/<hash>` (the
same convention git and restic use) — rather than a flat `objects/<hash>`. This is purely so a human (or
a third-party tool) browsing the bucket in the S3 console isn't looking at one flat listing of every
object the vault has ever stored; S3 itself has auto-scaled per-prefix request rates since 2018, so
there's no throughput reason to shard anymore. `objectKey()` in `src/vault/paths.ts` is the only place
this layout is decided — every read site consumes the `s3_key` column already stored on the `objects`
row rather than recomputing a key from a hash, so the layout could change again later without touching
any read path.

## Upload-before-reference, always

For every dirty cache row being folded into a sync, `applyLocalChangesToCandidate` does, in order:

1. Check `objects` for the hash. If present, skip the upload entirely (the dedup path).
2. If absent, and `verifyRemote` is active (see **Recovering an aborted run's already-uploaded
   objects** below): HEAD `objects/<hash[0:2]>/<hash[2:4]>/<hash>` on S3 directly. Present means the
   exact same bytes are already there — skip the upload and just record the rows, the same as step 1.
3. If still absent (or `verifyRemote` wasn't active): read the file, encrypt it, upload it to
   `objects/<hash[0:2]>/<hash[2:4]>/<hash>`, **then** insert its `objects` row.
4. Only then insert/update the `entries` row that references that hash.

This ordering means a crash between steps 3 and 4 leaves an uploaded-but-unreferenced object — wasted
space, never a dangling reference to bytes that don't exist. The next sync attempt just re-discovers
the local change (cache.db still shows it dirty) and re-checks `objects` for the hash — and, per the
next section, re-checks S3 directly too, rather than assuming the worst case is paying for the upload
a second time.

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

## Recovering an aborted run's already-uploaded objects

"Nothing durable was changed" above is true of local state, deliberately not of S3. Object uploads
happen against the _candidate_, so a crash anywhere between an object landing on S3 and the CAS commit
promoting that candidate leaves the object genuinely present remotely with no state.db, on this machine
or any other, ever having referenced it — the candidate that would have recorded it is discarded along
with everything else the run never got to finish. The next `sync` builds a fresh candidate from the
remote's latest _committed_ snapshot, which by construction has never heard of that object either, and
would upload the exact same bytes again — content-addressed dedup only ever protects against re-sending
content the vault has already **committed**, not content that merely reached S3.

`performSync` writes a durable marker, `.sync1/upload-in-progress`
(`localUploadInProgressMarkerPath`), immediately before its upload phase begins, and removes it on
either of this run's own clean exits — a real commit, or the "nothing needed committing" early return
(both mean nothing from this run's own upload phase is left unaccounted for). It is deliberately never
cleared in a `finally`: an abort or a thrown error partway through is exactly the case this exists to
survive, so those have to leave it in place.

Read at the very start of the _next_ `performSync`, before that run writes its own copy: present means
some earlier run's own marker was never reached to be cleared, so this run turns on `verifyRemote` for
its own upload phase (step 2 in **Upload-before-reference, always** above) — a HEAD check against S3
before dispatching a real upload for anything not already known to the fresh candidate. `--verify-remote`
forces the same behavior on for an ordinary run, independent of the marker, for a caller with some other
reason to want it. Both cases hand `verifyRemote` down to `applyLocalChangesToCandidate` as a plain
boolean; the HEAD-based existence check itself is sound for the identical reason step 1's local `objects`
lookup is — content-addressed keys plus convergent encryption mean "present" can only ever mean the
exact same plaintext, encrypted the exact same way, already made it.

Deliberately conditional rather than always-on: a HEAD per uploaded file is a real, measurable cost on a
many-small-files sync, and an ordinary clean run (no prior abort, no `--verify-remote`) pays zero extra
round trips for a recovery mechanism it will never need.

## Every object carries a proof that S3 stored it correctly

`objects.ciphertext_checksum` is **`NOT NULL`**, and that is a correctness property rather than a
schema preference.

The value is CRC64NVME over the _ciphertext_, base64. It is computed **client-side**, by
`UploadChecksumTap` (`src/s3/checksum.ts`), as the encrypted bytes stream past on their way to S3 — and
S3 computes the same thing independently and reports it back. `verifyStoredChecksum`
(`src/s3/client.ts`) compares the two and refuses to return unless they match. So the recorded value is
not a copy of something S3 said; it is the residue of an agreement between two independent
computations. Storing it is what makes a later audit — `mirror verify`, a remote content check —
meaningful without a download, a decryption, or the master key.

That matters most where it is least visible. Without a write-time check an upload trusts its `200`, so
an object S3 stored wrongly would surface only on a much later `materialize` — quite possibly after
`stubify` had already removed the last local copy, on the strength of that upload.

Three consequences follow, and they are easy to erode one at a time:

- **A backend that reports no checksum is a failure, not a tolerated quirk.** Silence means the
  comparison never happened, so nothing proved the upload landed. `verifyStoredChecksum` raises
  `CorruptionError` rather than returning early. **An S3-compatible backend that does not implement
  CRC64NVME is therefore unsupported for writing** — already true in practice, since the e2e harness
  pins a LocalStack version chosen for exactly this (see `test/e2e/helpers/localstack.ts`).
- **A locally computed substitute is never acceptable.** Convergent encryption means the same number
  could be re-derived from local plaintext with no download at all. Recording that would write a value
  nothing corroborated while making it indistinguishable from a verified one — an unverified upload
  laundered into an apparently-verified row, which is worse than having no row.
- **The `verifyRemote` HEAD shortcut declines itself when the HEAD reports no checksum**, falling
  through to a normal upload instead. That branch writes the only `objects` row its hash will ever get
  (every later run takes the local `objects` lookup and never re-upserts), so a gap there would be
  permanent. Re-uploading costs bandwidth once for an object predating the column, and self-heals.

Migration `0011` closed the door behind those callers. Because SQLite cannot add a column constraint in
place, it rebuilds `objects` — which only works with foreign key enforcement suspended, since
`entries.hash` references it; `runMigrations` handles that for the whole pass and runs a
`foreign_key_check` inside each migration's own transaction. Its comment records why the two obvious
alternatives silently do not work.

## The invariant is enforced at write time, not merely assumed

"An object at key H decrypts to content whose hash is H" is what makes all three shortcuts above sound
— the local `objects` lookup, the `verifyRemote` HEAD check, and (for anyone mirroring) skip-if-exists.
It used to be checked only at _read_ time, by `materialize` verifying decrypted content against the
recorded hash, and merely assumed when writing.

The gap is real and it is wide. `hash` and `size` come from the cache row `update_cache` wrote during
sync's **scanning** phase; the bytes are read from disk during the **uploading** phase, which on a
large vault is hours later. A file edited in between would be encrypted under the _old_ hash's context
and stored at the old hash's key.

A size change was already caught, by `readExact` in `encryptStream` running out of bytes. The dangerous
case is a **size-preserving** edit: the byte count is right, so `ContentLength` matches and the
CRC64NVME both ends compute agree on the bytes actually sent. Nothing else in the pipeline can tell.
It would surface only on a much later `materialize` — quite possibly after `stubify` had removed the
last local copy on the strength of that very upload.

Two guards now close it, and neither subsumes the other:

- **A re-stat before the first byte.** One syscall comparing mtime and size against the cache row.
  Rejects the common case without sending anything, which on a multi-GB file is the difference between
  wasting an upload and not starting one.
- **`encryptStream`'s `expectedHash`.** The plaintext is hashed as it is read and compared _between
  the last `readExact` and the last `yield`_ — the hash is complete, the final ciphertext chunk is not
  yet emitted. Throwing there leaves the body short of the declared `ContentLength`, so the SDK aborts
  the request mid-body and S3 discards an incomplete PUT; above the multipart threshold,
  `CompleteMultipartUpload` is simply never called.

That seam is what makes the object **never exist remotely**, rather than existing briefly and being
deleted afterwards. The difference matters: a compensating delete leaves a window in which another
machine's `verifyRemote` HEAD could adopt the bad object, and a failed cleanup would poison a
content-addressed key permanently. Move the comparison anywhere else — upstream of the codec, or after
the loop — and the seam is gone, which is why it lives inside the generator rather than around it.

`putObjectStream` also aborts the in-flight request when the body fails. Rejecting the caller's promise
only settles _our_ side; the SDK would keep waiting on a body that will never produce another byte, and
Node would not exit until the socket timed out — around a minute per failed object, long after the
failure was logged and moved past.
