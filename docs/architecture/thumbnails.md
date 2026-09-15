# Thumbnail generation

## Why

sync1's stub/materialize design already lets a user browse a vault's _tree_ (filenames, sizes) without
downloading everything — but deciding _what's actually worth materializing_ still means guessing from a
filename or downloading the full-size original just to look at it. Thumbnails close that loop: a small
preview image (or, for video, a mosaic of sampled frames) generated once and versioned like any other
tracked file, so a user can browse _content_, not just names, without ever materializing the originals.

## `thumbnail_policy`: deciding what gets a thumbnail

`thumbnail_policy` (table `thumbnail_policies` in `state.db`, global and versioned like `storage_policy`
and `ignore_policies`) pairs a glob with a mime-type filter and a `skip`/`generate` disposition. Unlike
`storage_policy`, there is **no mandatory default row** — a path matching no policy glob at all is simply
not a thumbnail candidate, the overwhelmingly common case for most of a tree. Resolution, in order:

1. Any matching `skip` row wins outright — monotonic OR, no priority needed among skips, exactly like
   `ignore_policies` (see [ignore-and-storage-policies.md](ignore-and-storage-policies.md)).
2. Otherwise, the lowest-`priority` matching `generate` row wins (same tie-break as `storage_policy`).
3. No match at all → not a candidate; nothing tallied, nothing probed.

"Matching" requires **both** the glob and the mime-type filter to match — a `skip`/`generate` row's
`mime_types` column (e.g. `["image/jpeg", "video/*"]`, the second segment may be a literal `*` wildcard)
is not optional decoration, so a policy can say "skip _videos_ under `private/**`, but leave images
there alone."

A `generate` row also carries the actual generation parameters: `image_width`/`image_height` (images),
`tile_row_count`/`tile_column_count`/`tile_width`/`tile_height` (video mosaics), and `jpeg_quality`
(both). A `CHECK` constraint (mirrored by repository-level validation, for a friendlier pre-network error)
enforces that all six generate-only columns are `NULL` for a `skip` row and all non-`NULL` for a
`generate` row.

## Walk-scoping via `literalPrefixOf`

Thumbnail-policy matching and `thumbnail`'s own `--glob` use the same glob syntax as every other command
in this CLI — see [the README's "Glob syntax" section](../README.md#glob-syntax) for the full dialect
(`*`/`?` segment-bound, native `**`, `{a,b}` brace expansion). Nothing here is thumbnail-specific anymore.

What _is_ still specific to `thumbnail` is `literalPrefixOf` (`src/fs/glob-match.ts`), used purely as a
walk-scoping optimization: `thumbnail`'s `--glob "Photos/**"` can root its filesystem walk at
`<root>/Photos` instead of `<root>`, pruning whole subtrees the pattern can never match. This never
affects correctness (a glob starting with a wildcard just walks everything, same as before), only how
much of the tree needs visiting.

## Naming convention and where thumbnails live

A thumbnail/mosaic lives in a `_thumbnail/` subdirectory of the same directory as its original, named
`<original-filename-with-extension>.<hash-hex>.<thumb-ext>`:

- `photos/sunset.jpg` → `photos/_thumbnail/sunset.jpg.<hash>.jpg`
- `videos/clip.mp4` → `videos/_thumbnail/clip.mp4.<hash>.jpg`

For an image, `<thumb-ext>` is always the original's own extension, verbatim (`.jpg` stays `.jpg`, `.png`
stays `.png`) — if the underlying tool can't produce that format, generation fails for that one file (see
below), it's never silently converted to something else. For a video mosaic, `<thumb-ext>` is always the
literal `jpg` (never `jpeg`) — one single spelling for "this is a JPEG" everywhere a thumbnail filename
gets reverse-parsed, regardless of the source video's own container.

The embedded `<hash-hex>` is the original's current content hash, from `cache.db` — this is what makes
"is this thumbnail up to date" a pure filename comparison, no need to open or re-hash anything. A
thumbnail whose embedded hash doesn't match the original's current `cache.db` hash is stale; if the
original's hash isn't in `cache.db` at all yet (never scanned by `update_cache`), the file is counted
under `missing_cache_entry` and skipped — reported, never blocking the rest of the run.

Thumbnails are themselves tracked, versioned, and uploaded exactly like any other file — no special
casing anywhere in `update_cache`/`sync`/`storage_policy`. The one accommodation elsewhere in the system
is that `storage_policy` globs can match `**/_thumbnail/*` to keep thumbnails in hot storage while their
(much larger) originals move to deep archive.

## Stubbed originals: a real, inherent limitation

A thumbnail can only be _generated_ from a real (materialized) file, never from a stub — there's no
content to read a frame or pixel from otherwise. This is checked only when generation would actually be
needed (a missing or stale thumbnail), never as a blanket exclusion: a stub whose existing thumbnail is
already up to date is still correctly reported as up to date, not needlessly flagged as blocked. Files
needing a fresh/updated thumbnail while stubbed are counted under `stubbed_original` — the practical
workflow is to thumbnail a file while it's genuinely present locally (e.g. right after upload, before
`stubify`), same as any other reason to keep a file materialized a little longer.

## One shared scan, three modes

`state`/`ensure`/`cleanup` (`sync1 thumbnail <mode>`) all share a single classification algorithm
(`scanThumbnails` in `src/fs/thumbnail.ts`) rather than three separate walks: one filesystem walk both
collects every existing `_thumbnail/` file (reverse-parsed back to the original it belongs to) and
dispatches mime-probing + policy resolution for every other candidate path. Mime-type detection (shelling
out to `identify`/`ffprobe` — see below) only ever runs for a path that already matches at least one
policy's glob, a cheap in-memory check with zero I/O — a path matching no policy at all is never probed.

Once the walk (and its dispatched classification jobs) fully settles, every candidate is reconciled
against the collected existing-thumbnail map into:

- **up to date** — an existing thumbnail's embedded hash matches.
- **to generate** — no existing thumbnail at all (and the original isn't currently a stub).
- **to regenerate** — an existing thumbnail's embedded hash is stale (and, again, not a stub).
- **to delete** — a `skip`-matched original still has an existing thumbnail, _or_ an existing thumbnail's
  original no longer matches any policy at all, _or_ its original was deleted/renamed, _or_ it simply fell
  outside this run's own `--glob` (a narrower `--glob` than usual will flag out-of-scope-but-visited
  thumbnails as orphans — a deliberate, documented consequence of scoping by directory, not a bug).

`state` only tallies, never writes anything. `ensure` dispatches actual generation for to-generate/to-
regenerate entries (deleting the stale file first, within the same job, when regenerating) back through
the same named concurrency pool used for classification. `cleanup` synchronously deletes every to-delete
file — deletion is cheap enough not to need its own pool dispatch.

A per-file `ThumbnailGenerationError` (bad/corrupt source, a format the underlying tool can't produce) is
caught, tallied under `errors`, and never aborts the run; a `MediaToolMissingError` (the `identify`/
`ffprobe`/`convert`/`ffmpeg` binary itself isn't on `PATH`) is fatal and propagates, since categorically
nothing can be thumbnailed at all without the tool.

## External tools, not a new npm dependency

Mime-type detection and actual generation shell out to already-installed binaries via
`node:child_process`: ImageMagick's `identify` (mime-sniff by magic bytes, never trusting a file
extension) and `convert` (resize), and `ffprobe`/`ffmpeg` (video mime-sniff, frame extraction, mosaic
composite). No new npm dependency was added — every native-binary npm alternative (`sharp`, a bundled
ffmpeg wrapper) would add exactly the kind of native-addon install complexity `better-sqlite3`/
`sodium-native` already impose, for no benefit over shelling out to tools already required to be present.

One real surprise, found by testing against an actual video fixture rather than trusting assumptions:
`identify` doesn't just fail on a non-image file — it happily reports a format (`MP4`) for an actual video
file too, since it has its own MP4 coder. `src/media/probe.ts`'s image-format table is therefore a small,
deliberate whitelist (`JPEG`, `PNG`, `GIF`, `BMP`, `TIFF`, `WEBP`, `HEIC`): only a format in that table is
ever treated as an image; anything else — including a video that `identify` technically "recognized" —
falls through to the `ffprobe` video probe instead of being guessed at.

## Resize math: `computeContainFitSize`

`src/media/thumbnail-generate.ts`'s `computeContainFitSize` is a pure function (no I/O, no subprocess) —
deliberately factored out on its own since it's the single highest-value, cheapest thing to get exactly
right and unit test exhaustively (`test/unit/media/thumbnail-generate.test.ts`).

The box's width/height are swapped internally (`effectiveBox`) so its long axis always aligns with the
source's long axis, regardless of how the box itself is configured — a portrait source always gets a
portrait-shaped effective box, never wasting box space by fitting into a mismatched orientation.

Past a source-to-box aspect-ratio ratio of exactly 2x, standard contain-fit would squeeze the short output
dimension to less than half the box's own short bound — past that point, the short output side is instead
forced to exactly the box's own short bound, and the long side is left to overflow the box's other bound
(never cropped, never distorted). The 2x threshold isn't arbitrary: it's precisely the ratio at which
ordinary contain-fit's short dimension equals exactly half the box's own short bound, a clean, exactly
unit-testable boundary (see the test file's "exactly at the boundary" / "just past it" cases).

Image thumbnails use the computed size directly via ImageMagick's `-resize "<W>x<H>!"` — the trailing `!`
forces those _exact_ pixel dimensions rather than letting ImageMagick recompute its own independent
aspect-preserving fit, which could otherwise disagree with `computeContainFitSize` by a rounding pixel.

## Video mosaics

A mosaic samples `tile_row_count * tile_column_count` frames at evenly-spaced, center-of-bucket
timestamps (`t_i = duration * (i + 0.5) / N`), deliberately avoiding literal first/last frames (often
black, blank, or credits). Each frame is fit (via `computeContainFitSize` against the tile box) and then
letterboxed (padded, centered, black-filled) to the exact `tile_width x tile_height` cell size — the
composite grid needs every cell identically sized, unlike a plain image thumbnail which needs no padding
at all. The grid itself is assembled via `ffmpeg`'s `xstack` filter with a computed row-major layout
string, into one JPEG (always JPEG, regardless of the source container) at a quality mapped from the
policy's 1-100 `jpeg_quality` onto `ffmpeg`'s mjpeg `-q:v` scale (2 = best, 31 = worst — inverted and much
coarser than JPEG's own percent scale). Temporary per-frame PNGs live under a fresh temp directory, always
removed in a `finally`, even when generation fails partway through.

## Parallelism

Classification (filesystem walk + mime probe + policy resolution) and generation both dispatch through
the same named pool, `pools.thumbnail` (a fourth `PQueue` alongside the existing three — see
[concurrency-and-progress.md](concurrency-and-progress.md)), sized by the global `--thumbnail-parallelism`
flag (default 4). One overall progress bar (files processed) is enough here — this command deliberately
stays on the plain item-count `ProgressSession` (see concurrency-and-progress.md's "Progress bars and
`--verbose`" section), not the combined files+bytes+ETA `BytesProgressSession` used by
`update_cache`/`sync`/`materialize`/`stubify`/`sanity_check`, since thumbnail generation isn't a
byte-transfer/hash operation -- "files processed" is the natural progress unit for this command.
