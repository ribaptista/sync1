# `sync1 thumbnail`

Generates and manages low-resolution thumbnails (images) and mosaics (videos) according to
[`thumbnail_policy`](thumbnail_policy.md) rules, so a user can browse a vault's actual content without
materializing full-size originals. See [thumbnails.md](../architecture/thumbnails.md) for the full design
— naming convention, resolution rules, the stubbed-original limitation, and the external tools used.

Local-only, same as `update_cache`/`sanity_check`: no password, no S3 client. `cache.db`/`state.db` are
read (never written) and only the local filesystem is touched (a `_thumbnail/` file written or deleted).

## Subcommands

| Subcommand          | Writes anything?               | Description                                                   |
| ------------------- | ------------------------------ | ------------------------------------------------------------- |
| `thumbnail state`   | no                             | Reports status only — never generates or deletes anything.    |
| `thumbnail ensure`  | generates missing/stale thumbs | Never deletes an extra thumbnail — see `cleanup` for that.    |
| `thumbnail cleanup` | deletes extra thumbs           | Never generates anything — only removes what shouldn't exist. |

All three share one classification pass over the tree; `state` is exactly what `ensure`/`cleanup` would
act on, reported without acting.

## Usage

```bash
sync1 thumbnail state --root <local-path> [--glob <pattern>] [--json] [--thumbnail-parallelism <n>]
sync1 thumbnail ensure --root <local-path> [--glob <pattern>] [--json] [--thumbnail-parallelism <n>]
sync1 thumbnail cleanup --root <local-path> [--glob <pattern>] [--json] [--thumbnail-parallelism <n>]
```

## Options

| Flag                          | Required | Description                                                                                          |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `--root <path>`               | yes      | Local directory to scan. Must already be initialized/attached.                                       |
| `--glob <pattern>`            | no       | Glob (supports `**`) scoping which files to consider. Also prunes the filesystem walk when possible. |
| `--thumbnail-parallelism <n>` | no       | Max concurrent classification/generation jobs. Default 4.                                            |

A `--glob` narrower than the one used on a previous run can cause a valid, up-to-date thumbnail outside
this run's scope to be flagged (and, under `cleanup`, deleted) as an orphan — this is a deliberate,
documented consequence of scoping by directory rather than a bug; see
[thumbnails.md](../architecture/thumbnails.md#one-shared-scan-three-modes).

## Output

```json
{
  "ok": true,
  "up_to_date": 12,
  "to_generate": 2,
  "to_regenerate": 0,
  "to_delete": 0,
  "missing_cache_entry": 0,
  "stubbed_original": 1,
  "errors": 0
}
```

`ok` is `false` (nonzero exit) when `errors > 0` — a per-file generation failure never aborts the run, but
does mark it as not fully successful. `stubbed_original` counts files that need a fresh/updated thumbnail
but can't get one because the original is currently a stub (not blocked if its existing thumbnail is
already up to date — see [thumbnails.md](../architecture/thumbnails.md)). `missing_cache_entry` counts
files matching a `generate` policy whose content hash isn't in `cache.db` yet — run `update_cache` first,
then retry.

## Exit codes

- `0` — success, no per-file generation errors.
- `1` — the root isn't initialized/attached, or at least one per-file generation error occurred
  (`errors > 0` in the output).

## Example

```bash
sync1 thumbnail_policy create "**/*.jpg" generate --root ~/Pictures \
  --mime-types image/jpeg --image-width 320 --image-height 240 \
  --tile-rows 4 --tile-columns 4 --tile-width 160 --tile-height 90 --jpeg-quality 80 --json

sync1 update_cache --root ~/Pictures --json
sync1 thumbnail state --root ~/Pictures --json
sync1 thumbnail ensure --root ~/Pictures --json
sync1 thumbnail cleanup --root ~/Pictures --glob "Photos/**" --json
```
