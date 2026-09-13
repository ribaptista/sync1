# `sync1 stubify`

Replaces fully-committed real files matching a glob pattern with stubs — freeing up local disk space
for content you don't need materialized right now. The counterpart to `materialize`.

## Usage

```bash
sync1 stubify <glob> --root <local-path> [--json] [--verbose] [--hash-parallelism <n>]
```

## Arguments and options

| Argument/Flag            | Required | Description                                                                                           |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------------- |
| `<glob>`                 | yes      | SQLite `GLOB` pattern matched against tracked paths.                                                  |
| `--root <path>`          | yes      | Local directory to operate on.                                                                        |
| `--hash-parallelism <n>` | no       | Max concurrent rehashing worker threads, only used for paths whose mtime changed. Default: CPU count. |

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

## Output

```json
{
  "ok": true,
  "stubified": 2,
  "already_stub": 0,
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
