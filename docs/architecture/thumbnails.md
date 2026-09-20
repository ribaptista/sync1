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
not a thumbnail candidate, the overwhelmingly common case for most of a tree. Unlike `storage_policy`,
there is also **no priority** — every matching `generate` row produces its own thumbnail, not just the
"best" one. Resolution, in order:

1. Any matching `skip` row wins outright — monotonic OR, no priority needed among skips, exactly like
   `ignore_policies` (see [ignore-and-storage-policies.md](ignore-and-storage-policies.md)) — and
   suppresses generation from _every_ matching `generate` row, not just the "closest" one.
2. Otherwise, **every** matching `generate` row generates its own thumbnail (`resolvePolicies` in
   `src/fs/thumbnail.ts`), each one distinguished in the resulting filename by its policy's own `name`
   (see "Naming convention" below) — two overlapping policies for the same file are not a conflict to
   resolve, they're two independently wanted previews.
3. No match at all (neither `skip` nor `generate`) → not a candidate; nothing tallied, nothing probed.

Every policy has a `name` — a required, globally-unique identifier (letters, digits, and underscores
only; enforced by both a `CHECK` constraint and a `UNIQUE` index) — which exists specifically so more
than one `generate` policy can match the same file without their outputs colliding on disk: it's what
makes the params segment of two different policies' thumbnails for the same original two different
filenames. A policy _rename_ is therefore indistinguishable, on disk, from deleting the old policy and
creating a new one under a new name — the next reconciliation produces exactly one deletion (the old
name's now-unclaimed file) and one regeneration (the new name's fresh one), which is the correct and
only way to react to a rename it has no other way to detect (see "Naming convention" below for how the
name is recovered from an existing filename without needing to parse out any of the other fields).

"Matching" requires **both** the glob and the mime-type filter to match — a `skip`/`generate` row's
`mime_types` column (e.g. `["image/jpeg", "video/*"]`, the second segment may be a literal `*` wildcard)
is not optional decoration, so a policy can say "skip _videos_ under `private/**`, but leave images
there alone."

A `generate` row is also always **exactly one media type or the other**, via a `media_type` column
(`image` or `video`, `NULL` for a `skip` row) — no policy carries fields belonging to the other type. An
`image` row's generation parameters are `image_width`/`image_height` and `jpeg_quality`; a `video` row's
are `tile_row_count`/`tile_column_count`/`tile_size` and `jpeg_quality` (the one field both share). A
three-way `CHECK` constraint (mirrored by repository-level validation, for a friendlier pre-network error)
enforces this: a `skip` row has `media_type` and all six generate-only columns `NULL`; a `generate`+`image`
row has `image_width`/`image_height`/`jpeg_quality` `NOT NULL` and the three tile columns `NULL`; a
`generate`+`video` row is the mirror image. `--tile-size` is a single value — the pixel length of a mosaic
tile's _shorter_ side, not a fixed box — see ["Video mosaics"](#video-mosaics) below for why there's no
tile width/height pair to configure independently anymore.

`ThumbnailPolicyRow` (`src/db/repositories/thumbnail-policies-repository.ts`) mirrors this at the type
level as a flat discriminated union on `action`/`mediaType` (flat, not nested — every consumer reads a
field like `policy.tileSize` directly), so a `generate`+`video` row is statically guaranteed to have
`tileSize` and statically guaranteed _not_ to have `imageWidth` — no `!` non-null assertions needed
anywhere generation code narrows on it. Every `mimeTypes` entry's own type segment (`image`/`video`,
never wildcarded) is validated to match a `generate` row's `mediaType`, which is what makes a
`resolvePolicies`-selected policy's `mediaType` _provably_ agree with whatever a file actually probed as
(`resolvePolicies` only ever returns policies whose `mimeTypes` matched the file's real, sniffed mime
type), not just usually-true by convention.

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
`<original-filename-with-extension>.<params-segment>.<hash-hex>.<thumb-ext>`:

- `photos/sunset.jpg` → `photos/_thumbnail/sunset.jpg.p1-thumb-iw320-ih240-q80.<hash>.jpg`
- `videos/clip.mp4` → `videos/_thumbnail/clip.mp4.p1-mosaic-tr4-tc4-ts90-q80.<hash>.jpg`

(assuming policies named `thumb` and `mosaic` respectively — see below.)

`<params-segment>` encodes the policy's own `name` followed by its raw _configured_ generation
parameters — never a per-file computed/derived size — as short literal abbreviated fields:
`p1-<name>-iw<imageWidth>-ih<imageHeight>-q<jpegQuality>` for an image policy,
`p1-<name>-tr<tileRowCount>-tc<tileColumnCount>-ts<tileSize>-q<jpegQuality>` for a video policy. The `p1`
prefix is a format version, not a real per-policy field — it exists so a future incompatible change to
this segment's own shape can be told apart from today's instead of silently misparsed.

The name is _why_ more than one matching `generate` policy for the same original never collides on disk
— two different policies, whatever their own fields, always produce two different segments as long as
their names differ (which the table's own `UNIQUE` constraint guarantees). It also doubles as the
identity reconciliation itself keys on: when deciding whether an existing file is _this_ policy's own
previous output (safe to delete-and-regenerate) versus some other policy's output or a genuine orphan,
`parseThumbnailEntry` extracts just the name token (`paramsSegment.split("-")[1]`, since the segment's
shape is always `p1-<name>-<field><num>...` by construction — no need to parse the rest) and compares
that, not the whole segment string, against the currently-resolved policy's own name. Matching by name
alone (not the full segment) is what lets an ordinary config edit — jpeg quality, image box, tile size —
still read as a regeneration of the _same_ thumbnail rather than a new one, while a full-segment
comparison is still what "up to date" itself means (see "One shared scan, three modes" below): a config
edit changes the segment, so the old file no longer satisfies the stricter up-to-date check even though
it's still recognized as this policy's own prior output.

A literal encoding was a deliberate choice over hashing the parameters together: worked the actual byte
budget rather than guessing — worst case (`p1-somepolicyname-tr9999-tc9999-ts65535-q100`) still leaves
plenty of the 255-byte-per-path-component limit spare even after the content hash (64 hex chars) and
extension, so length was never close to binding. A human being able to `ls _thumbnail/` and read off
exactly which policy, and what config, produced a file — no database cross-reference needed — is worth
far more than the handful of bytes a hash-of-params scheme would reclaim.

For an image, `<thumb-ext>` is normally the original's own extension, verbatim (`.jpg` stays `.jpg`,
`.png` stays `.png`) — except for a source mime type ImageMagick can read but not write at all (currently
just Canon's CR2 raw format, `image/x-canon-cr2` — see `RAW_IMAGE_MIME_TYPES` in `src/fs/thumbnail.ts`),
which is always forced to `.jpg` instead, since asking `convert` to _write_ the original's own format
would fail outright with no encoder available. For a video mosaic, `<thumb-ext>` is always the literal
`jpg` (never `jpeg`) — one single spelling for "this is a JPEG" everywhere a thumbnail filename gets
reverse-parsed, regardless of the source video's own container.

The embedded `<hash-hex>` is the original's current content hash, from `cache.db` — combined with
`<params-segment>` matching the current policy, this is what makes "is this thumbnail up to date" a pure
filename comparison, no need to open or re-hash anything. A thumbnail whose embedded hash or params
segment doesn't match the original's current `cache.db` hash / current policy is stale; if the original's
hash isn't in `cache.db` at all yet (never scanned by `update_cache`), the file is counted under
`missing_cache_entry` and skipped — reported, never blocking the rest of the run.

`parseThumbnailEntry` requires at least four dot-separated parts and validates the params segment's shape
(`PARAMS_SEGMENT_RE`) before accepting a file as a recognized thumbnail at all — this is deliberately
**not** backward compatible with a pre-params-segment filename (three dot-parts, e.g.
`sunset.jpg.<hash>.jpg`): that shape fails the check and is treated as an unrecognized file, left alone
forever, rather than being misparsed (its "params" slot would otherwise be read as the literal extension
token). There's no migration path needed for this, since no vault has ever shipped with a configured
thumbnail policy before this naming scheme existed.

Thumbnails are themselves tracked, versioned, and uploaded exactly like any other file — no special
casing anywhere in `update_cache`/`sync`/`storage_policy`. The one accommodation elsewhere in the system
is that `storage_policy` globs can match `**/_thumbnail/*` to keep thumbnails in hot storage while their
(much larger) originals move to deep archive. `stubify`, conversely, never touches `_thumbnail/` contents
at all, even under a glob broad enough to otherwise match them — see "Stubbed originals" below for why
that matters, and [stubify.md](../cli/stubify.md) for the mechanism.

## Stubbed originals: a real, inherent limitation

A thumbnail can only be _generated_ from a real (materialized) file, never from a stub — there's no
content to read a frame or pixel from otherwise. A stub also can't be _probed_ at all (no real bytes, so
no mime type, hence no policy resolution) — `classifyStub` (`src/fs/thumbnail.ts`) bypasses probing and
policy resolution for a stub entirely, doing a pure `cache.db`-hash lookup against already-collected
`_thumbnail/` files instead. That lookup, alone, is trustworthy: `update_cache` populates a stub's
`cache.db` row straight from `readStubHash(stubPathFor(...))` — the stub's own self-declared content hash
— exactly as reliable as a real file's hash would be. What can't be recovered without real bytes (mime
type, the expected thumbnail extension) simply isn't needed for _preservation_, only for _generation_,
which a stub is never a candidate for.

This reconciles into three outcomes, not a blanket "blocked":

- **No existing thumbnail at all** — nothing to preserve, counted under `stubbed_original`. The practical
  workflow is to thumbnail a file while it's genuinely present locally (e.g. right after upload, before
  `stubify`), same as any other reason to keep a file materialized a little longer.
- **An existing thumbnail whose hash matches** the stub's current content hash — still a faithful preview
  of the file's actual current content, counted under `stubbed_preserved`, and never touched in any mode,
  including `cleanup`. This is the fix for what would otherwise be a real bug: probing a stub unconditionally
  and getting a "not recognized as media" result (a nonexistent-file probe fails with a nonzero exit, not
  the tool-missing `ENOENT` the old code only checked for) meant a stubbed original's path never reached
  the classification pipeline's claimed-originals set, so its already-generated thumbnail looked like an
  unclaimed orphan and got deleted by the very next `cleanup` — defeating the entire point of having
  generated a preview for content deliberately kept unmaterialized.
- **An existing thumbnail whose hash doesn't match** — the file was edited after its thumbnail was
  generated, then stubified before a sync ever regenerated it. Neither trustworthy as-is (it's not
  actually a preview of the current content) nor safely discardable automatically (destroying the only
  copy of a preview that can't be recreated from the stub alone, without materializing the file first).
  Reported under `stale_stub_previews` (an array, not just a count — mirroring `update_cache`'s own
  `caseCollisions` precedent for "worth enumerating, not just tallying") and left on disk in every mode,
  including `cleanup`, unless `cleanup --delete-stale-stub-previews` is passed explicitly — see
  [thumbnail.md](../cli/thumbnail.md) for the flag.

A stub whose path matches no policy glob at all still correctly falls through to the ordinary orphan
sweep and is deleted normally, same as any other unmatched path — glob matching needs no mime type, so
this doesn't depend on probing either.

## One shared scan, three modes

`state`/`ensure`/`cleanup` (`sync1 thumbnail <mode>`) all share a single classification algorithm
(`scanThumbnails` in `src/fs/thumbnail.ts`) rather than three separate walks: one filesystem walk both
collects every existing `_thumbnail/` file (reverse-parsed back to the original it belongs to, including
its params segment) and classifies every other candidate path into one of two kinds. A real (or "both",
real-with-dangling-stub) entry is dispatched for mime-probing + policy resolution — only for a path that
already matches at least one policy's glob, a cheap in-memory check with zero I/O, so a path matching no
policy at all is never probed. A stub entry is classified synchronously instead, with no probing or
policy resolution at all (see "Stubbed originals" above) — `ProvisionalDecision` is a `"probed"`/`"stub"`
discriminated union at the type level, so a stub decision is structurally impossible to hand to the
generation code path.

Once the walk (and its dispatched classification jobs) fully settles, every candidate is reconciled
against the collected existing-thumbnail map. A "both"/real candidate reconciles **once per matching
`generate` policy**, independently — an original matching two policies is decided twice, against the
same `existing` list, each decision keyed by that one policy's own name (see "Naming convention" above):

- **up to date** — an existing thumbnail's embedded hash _and_ whole params segment both match this
  policy's current configuration.
- **to generate** — no existing file names this policy at all (and the original is a real file, not a
  stub).
- **to regenerate** — an existing file names this same policy (by name) but its embedded hash or the
  rest of its params segment is stale (and, again, a real file, not a stub — for a stub this is
  `stale_stub_previews` instead, see "Stubbed originals").
- **to delete** — after every matching policy has claimed its own up-to-date or stale match, anything
  left over in `existing` is unclaimed: a `skip`-matched original's entire existing set (every matching
  `generate` row is suppressed at once, so nothing is ever claimed for a skip-matched original), _or_ an
  existing thumbnail naming a policy that no longer matches this original at all (deleted, renamed, or
  its glob/mime-type edited away), _or_ its original was deleted/renamed, _or_ it simply fell outside
  this run's own `--glob` (a narrower `--glob` than usual will flag out-of-scope-but-visited thumbnails
  as orphans — a deliberate, documented consequence of scoping by directory, not a bug), _or_ it's a
  genuine leftover duplicate alongside a stub's preserved or up-to-date match.
- **stubbed original / stubbed preserved / stale stub previews** — see "Stubbed originals" above; a stub
  is never a to-generate/to-regenerate candidate.

`state` only tallies, never writes anything. `ensure` dispatches actual generation for to-generate/to-
regenerate entries (deleting the stale file first, within the same job, when regenerating) back through
the same named concurrency pool used for classification — never for a stub, which is never a generation
candidate. `cleanup` synchronously deletes every to-delete file, plus a stale stub preview's thumbnail
when `--delete-stale-stub-previews` was passed — deletion is cheap enough not to need its own pool
dispatch.

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
deliberate whitelist (`JPEG`, `PNG`, `GIF`, `BMP`, `TIFF`, `WEBP`, `HEIC`, `CR2`): only a format in that
table is ever treated as an image; anything else — including a video that `identify` technically
"recognized" — falls through to the `ffprobe` video probe instead of being guessed at.

**Canon CR2 raw is read-only** (`identify -list format` reports `CR2 DNG r--` — no encoder), confirmed
directly against a real file: `identify` reads its mime type and dimensions fine, and `convert` can decode
and resize it into a real JPEG, but asking `convert` to _write_ a `.CR2` would fail outright with no
encoder available. Every CR2 thumbnail is therefore forced to a `.jpg` destination regardless of the
source's own extension (see "Naming convention" above) — the same pattern video mosaics already use, for
the same reason.

**Video rotation.** `ffprobe`'s default `-show_entries` never asked for rotation metadata, so `probeVideo`
used to always report a stream's raw encoded dimensions — but `ffmpeg`'s own frame decoding auto-rotates
by default (confirmed directly: `-autorotate`, already explicit in the mosaic frame-extraction command
below, produces genuinely rotated pixel output), so a display-rotated video's _probed_ dimensions could
silently disagree with what every downstream consumer (mosaic frame sizing) would actually see — a
landscape-encoded, portrait-displayed video's mosaic would come out using the wrong aspect ratio
entirely. `probeVideo` now requests `stream_side_data=rotation` (the modern Display Matrix convention)
and `stream_tags=rotate` (the legacy pre-Display-Matrix one, checked only as a fallback) alongside its
existing `-show_entries` flags — confirmed these merge into one JSON response rather than overwriting each
other — and swaps `width`/`height` whenever the resolved rotation is in the 90-degree family (never for
180, which changes neither dimension). `resolveRotationDegrees`/`rotationSwapsDimensions`
(`src/media/probe.ts`) are exported pure helpers specifically because a real encode only ever produces one
rotation signal or the other, never both for the same file — unit tests are the only real coverage the
precedence rule between them can get.

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
black, blank, or credits).

There's no fixed tile box. A policy configures one `tile_size` — the pixel length of a mosaic tile's
_shorter_ side — and `computeMosaicFrameSize` (`src/media/thumbnail-generate.ts`, a pure function, no
I/O) scales the source so its own shorter side hits that value, with the longer side falling out of the
source's own aspect ratio rather than being configured independently:

```ts
const scale = shortSide / Math.min(source.width, source.height);
// width/height both scaled by that same factor
```

Deliberately has no orientation concept at all — no portrait/landscape branch, unlike
`computeContainFitSize`'s image path. Every frame sampled from _one_ video shares that video's own aspect
ratio, so `frame` is computed **once** per mosaic run, not per frame, and every sampled frame lands on
`frame`'s exact dimensions automatically, with no leftover space to letterbox. This replaced an earlier
fixed-box design (a separately configured `tile_width`/`tile_height` pair, with each frame fit via
`computeContainFitSize` and then letterboxed — padded, centered, black-filled — to that exact box) that
could crash outright (`"Padded dimensions cannot be smaller than input dimensions"`) whenever a declared
box's orientation disagreed with the source's real orientation — precisely the failure mode a rotated
source hits, and precisely why the rotation fix above and this redesign landed together: fixing only the
rotation metadata bug would have turned a silent stretch into a hard crash against the still-fixed box,
not fixed the underlying bug.

The grid itself is assembled via `ffmpeg`'s `xstack` filter with a computed row-major layout string, into
one JPEG (always JPEG, regardless of the source container) at a quality mapped from the policy's 1-100
`jpeg_quality` onto `ffmpeg`'s mjpeg `-q:v` scale (2 = best, 31 = worst — inverted and much coarser than
JPEG's own percent scale). The frame-extraction step passes `-autorotate` explicitly (a bare boolean flag
in this ffmpeg build's CLI — confirmed directly that `-autorotate 1` misparses as two separate tokens,
the flag plus a stray value ffmpeg then tries to apply to the _output_ file instead) rather than relying
on the tool's own default (on since ffmpeg ~4.4 — see [platform-setup.md](../platform-setup.md) for the
external tool version this project is developed and tested against). Temporary per-frame PNGs live under
a fresh temp directory, always removed in a `finally`, even when generation fails partway through.

## Parallelism

Classification (filesystem walk + mime probe + policy resolution) and generation both dispatch through
the same named pool, `pools.thumbnail` (a fourth `PQueue` alongside the existing three — see
[concurrency-and-progress.md](concurrency-and-progress.md)), sized by the global `--thumbnail-parallelism`
flag (default 4). This command deliberately stays on the plain item-count `ProgressSession` (see
concurrency-and-progress.md's "Progress bars and `--verbose`" section), not the combined files+bytes+ETA
`BytesProgressSession` used by `update_cache`/`sync`/`materialize`/`stubify`/`sanity_check`, since
thumbnail generation isn't a byte-transfer/hash operation -- "files processed" is the natural progress
unit for this command.

`state` and `cleanup` drive that one bar from the filesystem walk (`scanThumbnails`'s `onProgress`
callback) exactly as any other command would — neither mode ever generates anything, so "files scanned"
is the only meaningful progress unit for either. Its _denominator_ comes from a separate callback,
`onScanTotalKnown`, fed by a concurrent counting walk (`thumbnail-enumerate.ts`) that probes and matches
nothing: the real walk blocks on `waitForRoom` once the probe pool is full, so left to itself it could
only ever report its own scanned count as its own total — a bar pinned at 100%. The counting walk counts
every entry, directories included, to match exactly what `onProgress` reports as the numerator, and the
real walk's own final count is published last, marked final. See concurrency-and-progress.md's
"Enumeration vs. execution" section. `ensure` used to drive the same bar the same way, which
meant it filled during the (comparatively fast) walk and then sat static for however long the
(comparatively slow) actual generation work took — confirmed a genuine gap, not a documented decision:
the walk's own progress callback fired per row scanned, but the generation dispatch/join round had no
progress reporting of its own at all.

`ensure` now drives the bar from a _separate_ callback, `onGenerationProgress`, entirely independent of
the walk's `onProgress` (the two units — "files scanned" and "thumbnails generated" — aren't
commensurable, so there's no single running count that could serve both): the bar opens on the phase's
_exact, final_ total and its value advances by one each time a generation attempt completes —
successfully or not, from a `finally`, so a per-file failure still moves the bar rather than silently
stalling it. The total is exact because the reconciliation loop runs after the probe pool has gone idle,
so every candidate is already decided before any is dispatched; `scanThumbnails` collects them as
`GenerationJob`s and dispatches them in a second loop. (It previously dispatched as it decided, growing
the total by one per dispatch — and since dispatch blocks on `waitForRoom`, the denominator grew at
exactly the rate the work finished, which is the failure mode described in concurrency-and-progress.md's
"Enumeration vs. execution" section.) `ensure`'s own walk phase doesn't drive the bar at all under this scheme; since the
walk is the fast phase and generation is the slow one, this trades a moving bar during the part that
barely takes any time for a moving bar during the part that actually does.
