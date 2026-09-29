# The local mirror

An optional second, offline copy of the **encrypted** vault, written to a local directory or network
mount as a sync uploads. Configured by adding `mirror_path` to `.sync1/remote.json`; absent, nothing
below happens and sync behaves exactly as it did before.

```json
{ "bucket": "my-vault", "prefix": "v0", "region": "us-east-1", "mirror_path": "/mnt/backup-drive" }
```

## Why write it here rather than copy it back later

The obvious way to get a second copy is `rclone sync` from the bucket. That costs egress on every byte,
once, and again for every future change — on a large vault, real money for data you already have.

Content objects are **convergently** encrypted (see [vault-and-encryption.md](vault-and-encryption.md)):
identical plaintext always produces byte-identical ciphertext. The exact bytes S3 receives are therefore
already in hand, in memory, at upload time. Writing them to a second sink costs one local write and no
egress at all — and the result is bit-for-bit what the bucket holds, not merely equivalent.

## Layout, and why it matches the bucket exactly

```
<mirror_path>/vault.json
<mirror_path>/current
<mirror_path>/states/<version_stamp>
<mirror_path>/objects/<h[0:2]>/<h[2:4]>/<hash>
```

Produced by the _same_ `objectKey`/`stateSnapshotKey` functions the bucket uses (`src/vault/paths.ts`),
via `src/vault/mirror-paths.ts`. That is load-bearing, not tidiness: a directory laid out exactly like
the bucket can be served straight back with `rclone serve s3` or MinIO and attached with the existing
`attach_remote --endpoint`, so a restore needs no translation layer and no sync1-specific tooling. A
bespoke layout would make the drive readable only by this program — the opposite of what a
disaster-recovery copy is for.

The vault **prefix is deliberately not applied**. Inside a bucket it exists so several vaults can share
one; a mirror directory is already the vault's own. So the tree corresponds to `<bucket>/<prefix>/`.

**`mirror_path` may not live inside the vault root.** It would be walked as ordinary content and back
itself up, one generation per sync, without bound. Rejected at resolution rather than discovered as
runaway disk use.

## Two sinks, one read

The existence check is **per sink**. "Does S3 have it" and "does the mirror have it" are independent
questions, and only both being true is a skip:

| S3 has | Mirror has | What happens                                          |
| ------ | ---------- | ----------------------------------------------------- |
| yes    | yes        | skipped entirely                                      |
| yes    | no         | read + encrypt once → mirror only, no upload paid for |
| no     | yes        | read + encrypt once → S3 only                         |
| no     | no         | read + encrypt once → tee'd to both                   |

Getting this wrong is the defect the split exists to prevent. Sync takes three shortcuts past the
upload path — a local `objects` hit, a `verifyRemote` HEAD hit, and a same-batch in-flight attach — and
mirroring hung off the upload alone would silently skip every object that took one. From sync's point of
view those rows _succeeded_, so nothing would ever report the hole.

The mirror's existence check compares **size**, not checksum: `encryptedSize` is a pure function, so it
stays a single `stat`, and a truncated file is caught for free. Verifying stored bytes would mean
re-reading the whole mirror on every sync.

## Lockstep, and what it costs

The tee advances both branches together, so S3 goes no faster than the mirror does. That is a real
throughput cost on a slow mount, accepted deliberately in exchange for a simple guarantee: **a clean
sync means a complete mirror**, with no reconciliation pass and no partially-mirrored commit to reason
about.

## Ordering: objects, then the snapshot, then the pointer

[commit-pointer.ts](../../src/sync/commit-pointer.ts) states the invariant for S3 — objects and
snapshots are idempotent, `current` is not. The mirror follows the same sequence, and moves its pointer
only **after** S3's CAS has succeeded, so it can never name a version S3 has not committed.

Snapshots are mirrored from **two** places, and both are needed. `sync` commits through
`commit.ts`; `ignore`, `storage_policy` and `thumbnail_policy` mint version stamps through
`mutateStateDb`. Without the second hook, every policy edit would be a snapshot the mirror silently
never received. `mutateStateDb` resolves `mirror_path` from `remote.json` itself rather than taking it
as a parameter, precisely so a future caller cannot reintroduce that gap by forgetting to pass it.

`vault.json` is copied when the mirror lacks it. Without those few hundred bytes — the Argon2id salt and
verifier — the mirror is undecryptable even with the right password, so a mirror with objects but no
manifest is not a backup at all. **A copy on the same drive as the ciphertext is still not a backup of
the key material**; keep one somewhere that is neither the bucket nor the mirror.

## Atomicity

Every mirror write goes to a sibling temp and is published by `rename`. A reader therefore never sees a
partial file, and "a file exists at the final path" means "that file is complete" — which is what makes
the cheap existence check sound. The temp is a _sibling_ (`inTreeTempPath`) so the rename cannot cross a
filesystem; a temp in `/tmp` would silently degrade into a copy on a network mount, losing atomicity
exactly where it matters most.

Unlike S3, the mirror therefore needs no abort seam: a stream that errors partway leaves only a temp,
removed on the failing path and swept later.

**Atomic and durable are different properties, and the mirror needs both.** A bare rename is atomic --
nobody ever sees a half-written file -- but a crash can still lose the temp file's own unflushed bytes
before the rename even happens, or (on some filesystems, ext4 without `dirsync` most notably) roll back
the rename's own directory-entry change if it was never `fsync`'d. Either way the existence check above
would keep trusting a file that is now truncated, garbage, or simply gone -- forever, since nothing ever
re-checks it once written. `durableRenameWithRetry` (`src/fs/durable.ts`) closes both gaps: `fsync` the
temp file, rename it (retried through the usual `EBUSY`/`EPERM`/`EACCES` budget for a network mount or
external drive), then `fsync` the destination directory.

## Failure, retries, and the two budgets

Mirror failures are retried on a **bounded** budget — five attempts, 50 ms exponential — deliberately
unlike `withS3Retry`'s unbounded one. A dropped uplink comes back; a failing drive or a full filesystem
does not, and waiting forever on one is indistinguishable from a hang. `ENOSPC`, `EDQUOT`, `EROFS`,
`ENAMETOOLONG` and `EFBIG` fail on the first attempt, because no number of retries un-fills a disk.

**Keeping the budgets separate is not a refinement, it is the point.** `withS3Retry`'s retryable errnos
include `ETIMEDOUT` and `ENETUNREACH` — exactly what a dropped SMB mount throws — and it has no attempt
limit. A mirror errno reaching it unwrapped would drive an unbounded re-upload loop against S3 because a
_local_ mount vanished. `MirrorWriteError` carries no errno of its own, so `withS3Retry` classifies it
as non-transient and rethrows immediately, leaving the bounded budget to decide.

Once the budget is exhausted, `--on-mirror-max-retries` decides what that means:

- **`fail`** (default) — aborts the **entire run**, not just the object whose mirror write failed.
  `applyLocalChangesToCandidate` throws `MirrorRequiredError`, uncaught, all the way out of `sync`;
  nothing this run touched is committed, and the local upload-in-progress marker is left in place so
  the next sync's recovery check finds and adopts (rather than re-uploads) anything that already reached
  S3. This used to be a per-object failure — the object stayed dirty, everything else in the batch still
  committed — which meant a same-batch rename (a delete paired with a create sharing identical content)
  could split in half: the delete landing while the create's mirror-only write failed and stayed dirty,
  leaving that content referenced by nothing the vault still tracked and ripe for `gc --apply` to remove
  outright. Aborting the whole run is what closes that gap: nothing reaches the vault without reaching
  both copies, full stop, and a change that belongs together commits together or not at all. This also
  gives the stubify guarantee for free: an unmirrored file never reaches `state = 'unchanged'`, so
  `stubify` cannot act on it.
- **`ignore`** — the object commits to S3 anyway; the gap is counted, warned about, and left for
  `mirror catchup`. Backups keep progressing while the drive is detached, at the cost of
  committed-but-unmirrored objects being a normal state. Note the retry cannot simply resume: in
  lockstep the mirror's failure tore down the S3 branch too, so the unit is run once more with the
  mirror switched off for that object only.

`--skip-mirror` bypasses the mirror entirely for a run. It and `ignore` are the two ways to produce a
committed object with no second copy — which is exactly what `stubify`'s mirror gate exists to refuse to
act on.

**Metadata is different.** A failed `states/` or `current` write is never fatal: by then S3 has accepted
the snapshot and the CAS is done, so the vault is committed whatever happens locally. Throwing would
report a successful sync as a failure, _after_ the point of no return, leaving the caller nothing useful
to retry.

## Sequencing against an archive storage policy

Worth repeating where it bites: a complete mirror makes `DEEP_ARCHIVE` attractive, because S3 stops
being read for ordinary access and its latency stops mattering. But **complete the mirror first**. Once
objects are archived, a gap can only be filled by `mirror catchup --allow-download --request-retrieval`,
which means retrieval fees and a wait of hours to days per batch — where the same gap, filled while the
plaintext is still local, costs nothing and finishes at disk speed.

## Restoring from it

The mirror is a bucket in every respect but the protocol, so give it one:

```bash
rclone serve s3 /mnt/backup-drive --addr :9000 --auth-key ACCESSKEY,SECRETKEY
```

```bash
sync1 attach_remote --bucket my-vault --prefix "" --endpoint http://localhost:9000 --root /mnt/restore
```

Note the empty prefix: the mirror tree corresponds to `<bucket>/<prefix>/`, so it is served as a bucket
root. From there `materialize` works exactly as it does against S3 — which also means a full recovery
can be rehearsed offline, for free, as often as you like.
