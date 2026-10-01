# `sync1 sync`

The core command: reconciles local changes with the remote vault, in both directions, in one run.
Internally runs `update_cache` first, so you never need to run that separately before `sync`.

> Full sequence-diagram trace: [sync.md](../sequences/sync.md).

## Usage

```bash
sync1 sync [--root <local-path>] [--json] [--verbose] [--hash-parallelism <n>] [--file-stream-parallelism <n>] [--no-progress] [--verify-remote] [--skip-mirror] [--on-mirror-max-retries <fail|ignore>]
```

## Options

| Flag                                     | Required | Description                                                                                                                                                                                                            |
| ---------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--root <path>`                          | no       | Local directory to sync. Must already be initialized (`init_remote`) or attached (`attach_remote`). Defaults to the nearest ancestor directory with a `.sync1/`, searched from the current directory upward.           |
| `--hash-parallelism <n>`                 | no       | Max concurrent file-hashing worker threads, used by `sync`'s internal `update_cache` scan. Default: CPU count.                                                                                                         |
| `--file-stream-parallelism <n>`          | no       | Max concurrent encrypt+upload / download+decrypt pipelines, used by the upload and remote-apply passes. Default 4.                                                                                                     |
| `--verify-remote`                        | no       | HEAD-checks S3 for each not-yet-known object before uploading it, even without a prior aborted run's marker present. See **Recovering from an aborted run** below — normally this turns on by itself when it's needed. |
| `--skip-mirror`                          | no       | Ignore the configured `mirror_path` entirely for this run. Does nothing if no mirror is configured.                                                                                                                    |
| `--on-mirror-max-retries <fail\|ignore>` | no       | What a mirror write that has exhausted its retries means. `fail` (default) leaves the object uncommitted and its row dirty; `ignore` commits to S3 anyway and leaves the gap for `mirror catchup`.                     |

Bucket/prefix/endpoint/region are read from `.sync1/remote.json`, written by `init_remote`/`attach_remote` — not repeated here. See
[concurrency-and-progress.md](../architecture/concurrency-and-progress.md) for how `sync`'s three phases (scan, upload, remote-apply) each dispatch their own concurrent work — and get their own progress bar, since a combined denominator across local hashing and network transfer was never a real quantity.

## What it does, at a high level

1. Runs `update_cache` to bring `cache.db` up to date with the filesystem.
2. Fetches `/current` to see whether the remote vault has moved since this machine's last sync.
3. Folds every locally-dirty cache row into a candidate copy of state.db, applying the
   create/modified/deleted conflict rules (see
   [conflict-resolution.md](../architecture/conflict-resolution.md)) against whatever's actually there.
   Anything that conflicts is left dirty in `cache.db`, unresolved, for you to fix by hand — everything
   else still goes through in the same run.
4. Separately, materializes onto the filesystem any path that's in the candidate but not yet correctly
   reflected in `cache.db` — this is what actually pulls down changes another machine made (or, for a
   freshly-attached machine, the entire backup).
5. If anything real changed, uploads a new state.db snapshot and commits it via a conditional write on
   `/current`. If nothing real changed (every local change was a conflict or a no-op), no new version is
   created — any remote-only pulls still happened, and the local baseline still advances to match, but
   that's an adoption, not a commit.

## Conflicts

When a local change can't be reconciled automatically, `sync` still applies everything else it can and
reports the conflict(s) rather than aborting the whole run. A conflicted path's local file is **never**
overwritten, and its `cache.db` row stays dirty so the next `sync` re-evaluates it once you've resolved
it by hand (there's no built-in merge UI — resolution means deciding which side's content should win and
making the local file match that before syncing again).

## Uploads and transient S3 failures

A dropped connection, a read timeout, or S3 asking you to slow down are never fatal: every upload
retries such a failure for as long as it takes, with exponential backoff. For a large file this retry is
scoped to the part that actually failed, not the whole upload -- a multipart upload resends only the few
megabytes that didn't make it, not the whole file from byte zero, so a connection that drops periodically
on a 100 GB upload still eventually finishes rather than restarting into the same failure forever. See
[dedup-and-object-storage.md](../architecture/dedup-and-object-storage.md) for the part-size math and
why this replaced an earlier design built on `@aws-sdk/lib-storage`.

## Failed uploads

Distinct from a conflict: a conflict is a human decision this run correctly declined to make; a failed
upload is this run trying and not succeeding at something a per-row retry on a later `sync` can plausibly
fix -- a file that changed since it was scanned, its content no longer matching the hash it was scanned
under, or (under `--on-mirror-max-retries ignore`) a mirror write that failed on a unit whose S3 half
never completed either. One bad file doesn't take down the rest of the batch: everything else still
commits, and the failed path's `cache.db` row stays dirty for the next `sync` to retry, exactly like a
conflict. Unlike a conflict, no manual resolution is needed -- fixing whatever made the upload fail (a
permission problem, restoring the file to what it was when it was scanned) and running `sync` again is
enough.

`ok` is `false` and the run exits non-zero whenever `failed` is non-empty -- this used to be silent
beyond a debug log line, with the run reporting `ok: true` as long as _something_ in the batch
committed.

**A non-transient S3 error is not in this list, deliberately.** Every transient failure already gets
retried forever (see above), so anything an upload still raises after that is something no amount of
waiting fixes -- access denied, a missing bucket, a bug. Leaving that row dirty for the next `sync` to
retry would just waste that run hitting the same irrecoverable error again, so it isn't treated as a
per-row failure at all: it aborts the **whole run**, the same escalation an exhausted mirror write uses
under the default `--on-mirror-max-retries fail` (see **Mirroring to a second copy** below). Nothing
this run touched is committed, `ok` is `false`, and the error names the path and the underlying cause.
Objects already uploaded to S3 before the abort are not wasted -- the next `sync`'s own aborted-run
recovery (see below) finds and adopts them instead of re-uploading.

## Recovering from an aborted run

A `sync` killed mid-upload (Ctrl+C, a crash) can leave objects genuinely present on S3 with no local
state.db anywhere yet aware of them -- the candidate DB that would have recorded them never got
promoted, and is discarded along with everything else the interrupted run never finished. Left alone,
the next `sync` would simply re-upload that same content: its own fresh candidate, built from the
remote's latest known-committed snapshot, has no way to know those objects already exist.

`sync` writes a durable `.sync1/upload-in-progress` marker just before its upload phase begins, and
clears it once a run ends cleanly (either a real commit, or "nothing needed committing"). If the
_next_ `sync` finds that marker still present, it already knows some earlier run didn't get back here
to clear it, and HEAD-checks S3 before every not-yet-known upload rather than assuming a clean slate --
present means a prior run already put the exact same bytes there (content-addressed keys plus
convergent encryption make this a sound check), so this run just records the row instead of paying for
the PUT again. This is automatic; you never need to pass a flag for it.

`--verify-remote` forces the same HEAD-before-upload behavior on for an ordinary run, marker or not --
slower (a HEAD per not-yet-known upload), but useful if you have some other reason to suspect local
state and S3 have drifted apart and want `sync` to double-check rather than trust cache.db/state.db at
face value.

## Output

```json
{
  "ok": true,
  "version_stamp": "20260101T020000000Z-a1b2c3d4",
  "nothing_to_sync": false,
  "uploaded_objects": 2,
  "deduped_objects": 1,
  "local_entries_changed": 3,
  "remote_created": 1,
  "remote_modified": 0,
  "remote_deleted": 0,
  "conflicts": [],
  "failed": []
}
```

When there are unresolved conflicts, `ok` is `false` and `conflicts` is a non-empty array of
`{ "path": "...", "reason": "..." }`. When there are failed uploads (see **Failed uploads** above),
`ok` is `false` and `failed` is a non-empty array of `{ "path": "...", "hash": "...", "error": "..." }`.

## Exit codes

- `0` — success, no conflicts, no failed uploads.
- `1` — either a hard failure that aborted the run before anything committed (a non-transient S3 error,
  corrupt vault, missing password, or a mirror write that exhausted its retries under the default
  `--on-mirror-max-retries fail` — see **Uploads and transient S3 failures** and **Mirroring to a second
  copy** above/below), or a run that completed with one or more failed uploads (see **Failed uploads**
  above) and no conflicts.
- `2` — completed with one or more unresolved conflicts (whether or not any uploads also failed), or the
  remote moved on mid-attempt (a CAS race against another machine's concurrent commit) — in the
  CAS-race case, just run `sync` again.

## Example

```bash
SYNC1_PASSWORD='correct horse battery staple' sync1 sync --root ~/Pictures --json
```

## Mirroring to a second copy

When `.sync1/remote.json` carries a `mirror_path`, every object this run uploads is also written there,
in the bucket's own layout, as the same encrypted bytes. The existence check is per sink, so an object
S3 already has but the mirror lacks is written to the mirror without being re-uploaded.

```json
{ "bucket": "my-vault", "prefix": "v0", "region": "us-east-1", "mirror_path": "/mnt/backup-drive" }
```

Two counters join the summary and `--json`: `mirrored_objects` (written this run) and `mirror_failures`
(committed to S3 but not mirrored, only ever non-zero under `--on-mirror-max-retries ignore`).

**Under the default `fail`, a mirror write that exhausts its retries aborts the whole run, not just the
object it was writing.** `mirror_failures` therefore stays `0` under `fail` — the run either commits
with every mirror write having succeeded, or it commits nothing at all: exit `1`, `ok: false`, and an
`error` naming the mirror target and the underlying cause. This matters for more than the one object
that failed: a same-batch rename (a delete paired with a create sharing identical content, since there is
no rename primitive anywhere in this system) used to be able to split in half, with the delete
committing while the create's mirror-only write failed and stayed dirty — leaving that content
referenced by nothing the vault still tracked, and ripe for a later `gc --apply` to remove outright.
Aborting the whole run instead means a change that belongs together commits together or not at all.
Objects this run already uploaded to S3 before the abort are not wasted: the next `sync` finds and adopts
them (the same recovery a crash mid-run triggers) rather than re-uploading.

`--on-mirror-max-retries ignore` commits to S3 regardless, and is one of the two ways (with
`--skip-mirror`) to end up with a committed object that has no second copy on the mirror.
`mirror_failures` counts those, and it's what [`stubify`](stubify.md)'s mirror gate exists to refuse to
act on.

See [mirroring.md](../architecture/mirroring.md) for the layout, the ordering rules, the retry budgets,
and how to restore from the drive.

## Uploading into a storage-class policy

A brand-new object matching a [storage policy](storage_policy.md) (`GLACIER`/`DEEP_ARCHIVE`) is
uploaded straight into that class, not `STANDARD` followed by a separate copy — so if the policy already
exists before the matching file is first synced, there's nothing left for [`converge`](converge.md) to
do afterward. A dedup hit against content another path already committed keeps that object's existing
class regardless; `converge` (not this upload) is what resolves a shared object's policies disagreeing,
and what catches up a policy created or edited after the fact. See
[storage-class-policies.md](../architecture/storage-class-policies.md).
