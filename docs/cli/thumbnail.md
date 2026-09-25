# `sync1 thumbnail`

Generates and manages low-resolution thumbnails (images), mosaics, and animated GIFs (videos) according
to [`thumbnail_policy`](thumbnail_policy.md) rules, so a user can browse a vault's actual content without
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

All three share one bounded streaming classifier. A concurrent fast walk estimates work using only
globs, cache hashes, and expected-thumbnail existence checks; `identify`/`ffprobe` runs only in the real
per-source jobs. Progress advances once per processed source (including a later MIME/skip rejection),
and the current `processing`/`generating` path is shown beside the bar.

`ensure` generates into an extension-preserving temporary sibling and atomically renames it into place.
Stopping the command cannot expose a partially written thumbnail, and a failed regeneration leaves the
previous stale thumbnail intact.

## Usage

```bash
sync1 thumbnail state [--root <local-path>] [--glob <pattern>] [--json] [--thumbnail-parallelism <n>]
sync1 thumbnail ensure [--root <local-path>] [--glob <pattern>] [--json] [--thumbnail-parallelism <n>]
sync1 thumbnail cleanup [--root <local-path>] [--glob <pattern>] [--delete-stale-stub-previews] [--json] [--thumbnail-parallelism <n>]
```

## Options

| Flag                           | Required | Description                                                                                                                                                                                                                      |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--root <path>`                | no       | Local directory to scan. Must already be initialized/attached. Defaults to the nearest ancestor directory with a `.sync1/`, searched from the current directory upward.                                                          |
| `--glob <pattern>`             | no       | Glob (supports `**`) scoping which files to consider. Also prunes the filesystem walk when possible.                                                                                                                             |
| `--thumbnail-parallelism <n>`  | no       | Max concurrent classification/generation jobs. Default 4.                                                                                                                                                                        |
| `--delete-stale-stub-previews` | no       | `cleanup` only. Also deletes a stubbed original's existing thumbnail once its stub's own content hash no longer matches that thumbnail — see "Stale stub previews" below. Without this flag, `cleanup` leaves those files alone. |

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
  "stubbed_preserved": 3,
  "stale_stub_previews": [
    {
      "path": "clip.mp4",
      "thumbnail_path": "_thumbnail/clip.mp4.p2-video_mosaic-ss90-tr4-tc4-fmtimage_jpeg-q80.a1b2c3.jpg"
    }
  ],
  "errors": 0
}
```

`ok` is `false` (nonzero exit) when `errors > 0` **or** `stale_stub_previews` is non-empty — a per-file
generation failure, or an unregenerable stale preview sitting on disk, both mark the run as not fully
successful, even though neither one aborts it. `stubbed_original` counts files that need a fresh/updated
thumbnail but can't get one because the original is currently a stub and has no existing thumbnail at all.
`stubbed_preserved` counts stubbed originals whose existing thumbnail is still a valid preview of the
stub's current content (matching hash) — never touched, in any mode, including `cleanup`. `missing_cache_entry`
counts files matching a `generate` policy whose content hash isn't in `cache.db` yet — run `update_cache`
first, then retry.

### Stale stub previews

A stub has no real bytes on disk, so its existing thumbnail can only be _preserved_ (hash matches) or
_flagged stale_ (hash doesn't match) — never regenerated in place, since regenerating needs the real file.
A stale entry means the file was edited after its thumbnail was generated, then stubified before a sync
ever regenerated that thumbnail: the preview on disk no longer reflects the file's current content, but
the only way to get a correct one is to `materialize` the file first. Because deleting the last copy of an
unregenerable preview is a bigger decision than the other `cleanup` buckets, it needs its own explicit
opt-in — `cleanup --delete-stale-stub-previews` — rather than happening automatically. `state`/`ensure`
report `stale_stub_previews` the same way but never delete anything themselves (neither mode deletes at
all).

## Exit codes

- `0` — success, no per-file generation errors, no stale stub previews.
- `1` — the root isn't initialized/attached, at least one per-file generation error occurred
  (`errors > 0`), or at least one stale stub preview was found (`stale_stub_previews` non-empty).

## Example

```bash
sync1 thumbnail_policy create "**/*.jpg" generate --root ~/Pictures \
  --name jpg_thumb --mime-types image/jpeg --media-type image \
  --resizing-strategy fit_to_box \
  --image-width 320 --image-height 240 \
  --output-mime image/jpeg --jpeg-quality 80 --json

sync1 update_cache --root ~/Pictures --json
sync1 thumbnail state --root ~/Pictures --json
sync1 thumbnail ensure --root ~/Pictures --json
sync1 thumbnail cleanup --root ~/Pictures --glob "Photos/**" --json
```
