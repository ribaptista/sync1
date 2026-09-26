# `sync1 stubify`

Replaces fully-committed real files matching a glob pattern with stubs — freeing up local disk space
for content you don't need materialized right now. The counterpart to `materialize`.

## Usage

```bash
sync1 stubify <glob> [--root <local-path>] [--json] [--verbose] [--hash-parallelism <n>]
```

## Arguments and options

| Argument/Flag            | Required | Description                                                                                                                             |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `<glob>`                 | yes      | [Glob pattern](../README.md#glob-syntax) matched against tracked paths.                                                                 |
| `--root <path>`          | no       | Local directory to operate on. Defaults to the nearest ancestor directory with a `.sync1/`, searched from the current directory upward. |
| `--hash-parallelism <n>` | no       | Max concurrent rehashing worker threads, only used for paths whose mtime changed. Default: CPU count.                                   |

No password needed — this never touches encrypted content, it only replaces local bytes with a stub
referencing an already-known hash.

## Precondition: must be fully committed

A matched file is only stubbed if its `cache.db` row is `unchanged` (no pending local edits) _and_ its
actual current content still matches what was last synced. To avoid rehashing potentially huge files on
every call, the mtime check from `update_cache` is reused: if the file's mtime still matches the
recorded baseline, the recorded hash is trusted; if it doesn't, the file is rehashed and the result must
still match before proceeding. Either check failing means the file is skipped (not stubbed) with a
reason — this is what stops `stubify` from silently discarding an edit that was never synced. A needed
rehash dispatches to a worker-thread pool rather than blocking the scan (see
[concurrency-and-progress.md](../architecture/concurrency-and-progress.md)); the common case (mtime
unchanged) never touches it at all.

## Crash safety

The stub is written first (atomically, via a temp file and rename) and the real file is deleted only
after that succeeds — the mirror image of `materialize`'s ordering. An interrupted `stubify` leaves both
the stub and the real file present, which `update_cache`/`sync` already know how to resolve safely
(the real file wins, the stray stub is cleaned up).

## Never touches `_thumbnail/` contents

A glob-matched row living under a `_thumbnail/` directory (at any depth, not just a direct child) is
always excluded automatically — no flag to pass, no glob to remember writing by hand. A thumbnail exists
specifically to preview an original that's deliberately _not_ kept materialized locally; stubifying the
preview itself would defeat that. Counted separately under `thumbnail_dir_excluded`, not `skipped` — this
is an expected, potentially large exclusion (every thumbnail under `<glob>`), not a per-file anomaly worth
enumerating one by one. See [thumbnails.md](../architecture/thumbnails.md) for the full thumbnail design.

## Output

```json
{
  "ok": true,
  "stubified": 2,
  "already_stub": 0,
  "thumbnail_dir_excluded": 0,
  "skipped": [{ "path": "notes.txt", "reason": "not fully committed (has pending local changes)" }]
}
```

`ok` is `false` whenever anything was skipped, even though the paths that _could_ be stubbed still were
— check `skipped` for which ones and why.

## Exit codes

- `0` — the command ran to completion (some paths may still be listed under `skipped`; see `ok`/`--json`
  output rather than the exit code for that).
- `1` — the root isn't initialized/attached, or a filesystem error.

## Example

```bash
sync1 stubify "photos/2020/*" --root ~/Pictures --json
```

## Refuses an unmirrored file

When the vault has a `mirror_path` configured, a file whose content is not on the mirror is **skipped**,
with `ok: false` and the reason `not yet mirrored`. `--allow-unmirrored` overrides it, and nothing
changes at all for a vault with no mirror.

The reasoning is the same one that makes this command careful in the first place. Stubbing deletes the
last _local_ copy of a file's content, on the strength of the remote one. With a mirror configured you
have arranged for two remote copies; acting as though you had two when you have one is precisely the
situation worth refusing.

It is mostly redundant by construction, and deliberately so: under the default
`--on-mirror-max-retries fail`, a mirror write that fails also fails the object, so its cache row never
reaches `unchanged` and this command would skip it anyway. The gate covers the two cases that escape
that — content committed before `mirror_path` was configured, and runs made with `--skip-mirror` or
`--on-mirror-max-retries ignore`.

The check costs one `stat`. It reads `hash` off the cache row this command already has, so
**stubify still needs neither `state.db` nor the password**. Run
[`sync1 mirror catchup`](mirror.md) to close the gap, and the skip goes away.
