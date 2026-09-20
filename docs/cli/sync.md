# `sync1 sync`

The core command: reconciles local changes with the remote vault, in both directions, in one run.
Internally runs `update_cache` first, so you never need to run that separately before `sync`.

## Usage

```bash
sync1 sync [--root <local-path>] [--json] [--verbose] [--hash-parallelism <n>] [--file-stream-parallelism <n>] [--no-progress] [--verify-remote]
```

## Options

| Flag                            | Required | Description                                                                                                                                                                                                            |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--root <path>`                 | no       | Local directory to sync. Must already be initialized (`init_remote`) or attached (`attach_remote`). Defaults to the nearest ancestor directory with a `.sync1/`, searched from the current directory upward.           |
| `--hash-parallelism <n>`        | no       | Max concurrent file-hashing worker threads, used by `sync`'s internal `update_cache` scan. Default: CPU count.                                                                                                         |
| `--file-stream-parallelism <n>` | no       | Max concurrent encrypt+upload / download+decrypt pipelines, used by the upload and remote-apply passes. Default 4.                                                                                                     |
| `--verify-remote`               | no       | HEAD-checks S3 for each not-yet-known object before uploading it, even without a prior aborted run's marker present. See **Recovering from an aborted run** below — normally this turns on by itself when it's needed. |

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
  "conflicts": []
}
```

When there are unresolved conflicts, `ok` is `false` and `conflicts` is a non-empty array of
`{ "path": "...", "reason": "..." }`.

## Exit codes

- `0` — success, no conflicts.
- `1` — a hard failure unrelated to conflicts (network/S3 error, corrupt vault, missing password).
- `2` — completed with one or more unresolved conflicts, or the remote moved on mid-attempt (a CAS race
  against another machine's concurrent commit) — in the CAS-race case, just run `sync` again.

## Example

```bash
SYNC1_PASSWORD='correct horse battery staple' sync1 sync --root ~/Pictures --json
```
