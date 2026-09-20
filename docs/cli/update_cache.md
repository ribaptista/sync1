# `sync1 update_cache`

Scans the local root directory and refreshes `cache.db` to match what's actually on disk. This is the
local, filesystem-facing half of the sync story — it never talks to S3 and never needs the vault
password (cache.db is unencrypted, see
[cache-and-filesystem-scanning.md](../architecture/cache-and-filesystem-scanning.md) for why that's
fine). `sync` runs this internally before doing anything else, but it's also useful standalone to see
what's changed without pushing anything.

## Usage

```bash
sync1 update_cache [--root <local-path>] [--json] [--verbose] [--hash-parallelism <n>] [--no-progress]
```

## Options

| Flag                     | Required | Description                                                                                                                                                                                                  |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--root <path>`          | no       | Local directory to scan. Must already be initialized (`init_remote`) or attached (`attach_remote`). Defaults to the nearest ancestor directory with a `.sync1/`, searched from the current directory upward. |
| `--hash-parallelism <n>` | no       | Max concurrent file-hashing worker threads. Default: CPU count.                                                                                                                                              |

Hashing runs on real worker threads (see
[concurrency-and-progress.md](../architecture/concurrency-and-progress.md)), since it's the one
CPU-bound, embarrassingly-parallel-across-files step in the scan; everything else in the merge-join
stays on the main thread.

## What it does

For every path currently on disk (skipping the `.sync1/` directory itself) and every path already
known in `cache.db`, in lockstep sorted order:

- **New path** → `created`, content hashed (files only; directories get a `null` hash).
- **Path gone from disk** → `deleted` (hash/mtime cleared). Re-running over an already-deleted path is
  a no-op.
- **Path recreated after a deletion** → treated as a fresh `created`, not a `modified`.
- **Path unchanged** → if its recorded mtime still matches, nothing is re-read or re-hashed at all —
  large files are never rehashed unless their mtime actually changed.
- **mtime changed but content didn't** (e.g. a bare `touch`) → mtime is refreshed, state is left alone.
- **mtime and content both changed**: if the path's cache row was already `unchanged`, it becomes
  `modified`/`created` with a fresh baseline; if it was already pending (`created`/`modified` from an
  earlier, not-yet-synced run), it stays in that same category — its original baseline isn't disturbed,
  only its recorded hash/mtime are refreshed.

## Output

```json
{ "ok": true, "created": 2, "modified": 1, "deleted": 0, "unchanged": 40 }
```

## Exit codes

- `0` — success (even if nothing changed).
- `1` — root not initialized/attached, or a filesystem error.

## Example

```bash
sync1 update_cache --root ~/Pictures --json
```
