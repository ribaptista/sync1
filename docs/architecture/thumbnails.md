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
(`image` or `video`, `NULL` for a `skip` row) — no policy carries fields belonging to the other type.
Beyond that, a `generate` row's fields split into **two independent axes** that never interact except at
one legality check: **sizing** (how many pixels the output has) and **encoding** (how those pixels are
compressed).

**Sizing** — each media type further splits into two branches of its own:

| `media_type` | discriminant                                | its own fields                                        |
| ------------ | ------------------------------------------- | ----------------------------------------------------- |
| `image`      | `resizing_strategy = 'fit_to_box'`          | `image_width`, `image_height`                         |
| `image`      | `resizing_strategy = 'resize_shorter_side'` | `shorter_side`                                        |
| `video`      | `output_type = 'mosaic'`                    | `tile_row_count`, `tile_column_count`, `shorter_side` |
| `video`      | `output_type = 'preview'`                   | `shorter_side`, `frame_count`, `frame_delay_ms`       |

`shorter_side` is deliberately the one field shared by every branch but `fit_to_box`: one output _unit's_
shorter-side target in pixels — an image's own for `resize_shorter_side`, one mosaic tile's (**not** the
composed grid's) for `mosaic`, one frame's for `preview`. It used to be two separately-named columns
(`shorter_side` for images, `tile_size` for video) before this policy gained a second discriminant; they
were always the same operation (`computeShorterSideFitSize`), so the columns were merged.

**Encoding** — every `generate` row also picks `output_mime`, independent of its sizing branch:

| `output_mime` | its own fields                  |
| ------------- | ------------------------------- |
| `image/jpeg`  | `jpeg_quality`                  |
| `image/png`   | `png_compression_level`         |
| `image/webp`  | `webp_quality`, `webp_lossless` |
| `image/gif`   | `gif_max_colors`, `gif_dither`  |

`output_mime` is **always required** — there is no format inheritance from the original file (an earlier
design inherited the source's own extension, which is both why HEIC sources used to fail generation
forever — ImageMagick can read `image/heic` but not write it — and why an unbrowsable format like TIFF
could end up as a thumbnail's own output format; dropping inheritance entirely makes both bugs disappear
by construction, rather than patching around them with more source-format special cases).

The two axes meet at exactly one legality rule: `mosaic` never allows `image/gif` (a one-frame
"animation" is strictly worse than any alternative still format), and `preview` only allows
`image/gif`/`image/webp` (always animated, never a still format). Every image sizing branch allows all
four encodings.

A three-way `CHECK` constraint (mirrored by repository-level validation, for a friendlier pre-network
error) enforces all of this: one clause for sizing-columns-match-branch, one for
encoding-columns-match-`output_mime`, and one small clause connecting the two axes (the legality rule
above) — three independent, much smaller clauses rather than one flat enumeration of all 14 legal
combinations, exactly as strict either way.

`ThumbnailPolicyRow` (`src/db/repositories/thumbnail-policies-repository.ts`) mirrors this at the type
level as a flat discriminated union generated from the same two axes (`Generate<Sizing, Encoding>`, a
distributive mapped type — `Generate<A|B, C|D>` produces the genuine flat union `(A&C)|(A&D)|(B&C)|(B&D)`,
not a union nested inside an intersection, so ordinary discriminant narrowing on `resizingStrategy`/
`outputType`/`outputMime` behaves exactly as ​it would for a hand-written union) rather than a hand-written
14-arm union repeating every field across every arm that has it — a future fifth encoding format is one
new declaration, not four new arms. `SIZING_FIELDS`/`ENCODING_FIELDS` (exported from the repository,
reused verbatim by the CLI's own pre-network validation rather than duplicated) are the single source of
truth for which fields belong to which axis value. Every `mimeTypes` entry's own type segment
(`image`/`video`, never wildcarded) is validated to match a `generate` row's `mediaType`, which is what
makes a `resolvePolicies`-selected policy's `mediaType` _provably_ agree with whatever a file actually
probed as (`resolvePolicies` only ever returns policies whose `mimeTypes` matched the file's real,
sniffed mime type), not just usually-true by convention — this is entirely about the _source_ mime
filter, unrelated to `outputMime`, which is what a `generate` policy _produces_.

**One TypeScript design note worth flagging:** `ThumbnailPolicyCreateInput` (`Omit<ThumbnailPolicyRow,
"id"|"createdAt">`) must use a _distributive_ `Omit`, not the built-in one — plain `Omit` computes
`keyof` on a union as the _intersection_ of member keys, which silently collapses a multi-arm union down
to only the fields every arm shares, losing every discriminant-specific field (`imageWidth`,
`jpegQuality`, etc.) without a type error anywhere. `DistributiveOmit<T, K> = T extends unknown ?
Omit<T, K> : never` forces the union to distribute first, exactly like `Generate<>` above, before
applying `Omit` to each already-narrowed member individually.

### Switching branches via `edit`, and why fields carry across it

`ThumbnailPoliciesRepository.update()` merges a partial edit onto the existing row, and a single generic
rule decides whether each axis-specific field carries over: it carries only if the row's **new** branch
(after applying whatever `action`/`mediaType`/`resizingStrategy`/`outputType`/`outputMime` the edit itself
changes) also includes that field in its own set (`SIZING_FIELDS` ∪ `ENCODING_FIELDS` for the new
combination). Concretely, `old[fieldName]` (already `null` for any field the _old_ branch didn't have, by
construction) is used as the fallback whenever a field isn't explicitly overridden in the edit — so
"carry forward if the new branch wants this field" degrades correctly to "nothing to carry" when the old
branch never had it either, with no field-specific special case needed.

This one rule is what makes `shorterSide` survive a `mosaic`↔`preview` switch, or an
`image/resize_shorter_side`↔any-video switch (every branch but `fit_to_box` shares it), _and_ what makes
an encoding field (`jpegQuality`, etc.) survive any switch that leaves `outputMime` unchanged — the same
mechanism, not two different ones. But switching `outputType` from `mosaic` to `preview` **without**
also changing `outputMime` fails outright, even before the missing-fields check runs: `preview` never
allows `image/jpeg`, so simply carrying the old `outputMime` forward is caught by the legality rule
described above. `edit --output-type preview --output-mime image/gif ...` on an existing `mosaic` policy
keeps its `shorterSide` untouched (now meaning "this preview's frame shorter side" instead of "this
mosaic tile's shorter side") while dropping `tileRowCount`/`tileColumnCount` (mosaic-only) and
`jpegQuality` (now illegal) — and still requires `--gif-max-colors`/`--gif-dither` to be supplied, since
neither the old branch nor a bare `--output-mime image/gif` edit provides them.

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

- `photos/sunset.jpg` → `photos/_thumbnail/sunset.jpg.p2-thumb-iw320-ih240-fmtimage_jpeg-q80.<hash>.jpg`
- `videos/clip.mp4` → `videos/_thumbnail/clip.mp4.p2-mosaic-ss90-tr4-tc4-fmtimage_jpeg-q80.<hash>.jpg`

(assuming policies named `thumb` and `mosaic` respectively — see below.)

`<params-segment>` encodes the policy's own `name`, then one token per SIZING field, then an
`fmt<outputMime>` token, then one token per ENCODING field — raw _configured_ generation parameters,
never a per-file computed/derived size — mirroring the repository's own two-axis split
(`expectedParamsSegment` in `src/fs/thumbnail.ts`):

| sizing branch                 | sizing tokens                                          |
| ----------------------------- | ------------------------------------------------------ |
| `image`/`fit_to_box`          | `iw<imageWidth>-ih<imageHeight>`                       |
| `image`/`resize_shorter_side` | `ss<shorterSide>`                                      |
| `video`/`mosaic`              | `ss<shorterSide>-tr<tileRowCount>-tc<tileColumnCount>` |
| `video`/`preview`             | `ss<shorterSide>-fc<frameCount>-fd<frameDelayMs>`      |

| `outputMime` | encoding tokens (after `fmt<outputMime>`) |
| ------------ | ----------------------------------------- |
| `image/jpeg` | `q<jpegQuality>`                          |
| `image/png`  | `pl<pngCompressionLevel>`                 |
| `image/webp` | `wq<webpQuality>-wl<0\|1>`                |
| `image/gif`  | `mc<gifMaxColors>-dt<gifDither>`          |

Example: `sunset.jpg.p2-photo_thumb-iw320-ih240-fmtimage_webp-wq80-wl0.<hash>.webp`. The `p2` prefix is a
format version, not a real per-policy field — it exists so a future incompatible change to this segment's
own shape can be told apart from today's instead of silently misparsed. It bumped from `p1` when this
policy gained `output_mime`/per-format encoding fields, since some of the new tokens (`gifDither` values
like `sierra2_4a`, the `fmt` token itself) aren't purely numeric the way every `p1` field was —
`PARAMS_SEGMENT_RE` deliberately still accepts **both** `p1-` and `p2-`: an existing `p1` thumbnail on a
real vault stays recognized (by the policy-name lookup, which parses identically on either version),
counted `toRegenerate`, and is deleted as its `p2` replacement is written — no manual cleanup needed for
the one-time upgrade.

Field _values_ are normalized, not escaped, through a single rule: any character outside
`[0-9A-Za-z_]` becomes `_` (so `image/webp` serializes as `fmtimage_webp`). No escaping and no tokenizer
needed — plain `split("-")` stays correct, since a normalized value can never reintroduce the `-` field
separator. This is only safe because of what's actually serialized through it: policy names are already
restricted to this exact charset by `NAME_PATTERN` (so normalization is a no-op for them, and `UNIQUE(name)`
still implies a unique serialized token), and the two closed enums that pass through it (`outputMime`,
`gifDither`) have members that stay distinct after normalization.

The name is _why_ more than one matching `generate` policy for the same original never collides on disk
— two different policies, whatever their own fields, always produce two different segments as long as
their names differ (which the table's own `UNIQUE` constraint guarantees). It also doubles as the
identity reconciliation itself keys on: when deciding whether an existing file is _this_ policy's own
previous output (safe to delete-and-regenerate) versus some other policy's output or a genuine orphan,
`parseThumbnailEntry` extracts just the name token (`paramsSegment.split("-")[1]`, since the segment's
shape is always `p{1,2}-<name>-<field><value>...` by construction — no need to parse the rest) and
compares that, not the whole segment string, against the currently-resolved policy's own name. Matching
by name alone (not the full segment) is what lets an ordinary config edit — jpeg quality, image box,
output mime — still read as a regeneration of the _same_ thumbnail rather than a new one, while a
full-segment comparison is still what "up to date" itself means (see "One shared scan, three modes"
below): a config edit changes the segment, so the old file no longer satisfies the stricter up-to-date
check even though it's still recognized as this policy's own prior output.

A literal encoding was a deliberate choice over hashing the parameters together: worked the actual byte
budget rather than guessing — worst case still leaves plenty of the 255-byte-per-path-component limit
spare even after the content hash (64 hex chars) and extension, so length was never close to binding. A
human being able to `ls _thumbnail/` and read off exactly which policy, and what config, produced a file
— no database cross-reference needed — is worth far more than the handful of bytes a hash-of-params
scheme would reclaim.

`<thumb-ext>` is a pure function of the policy's own `outputMime` — `jpg`/`png`/`webp`/`gif` (never
`jpeg` — one single spelling for "this is a JPEG" everywhere a thumbnail filename gets reverse-parsed) —
and has nothing to do with the source's own extension or mime type at all, now that `output_mime` is
always required. This is what makes a write-incapable source format (Canon CR2 raw, `image/x-canon-cr2`
— `identify -list format` reports `CR2 DNG r--`, no encoder) and an unbrowsable one (TIFF) both a
non-issue by construction: the policy simply states a browser-compatible `output_mime` and that's what
gets written, regardless of what `convert`/`ffmpeg` can or can't do with the source's own format.

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

## One streaming algorithm, three modes

`state`/`ensure`/`cleanup` (`sync1 thumbnail <mode>`) share one streaming classification algorithm
(`scanThumbnails` in `src/fs/thumbnail.ts`). A fast advisory walk runs concurrently with the real walk.
It only matches globs, reads a source's cache hash, derives deterministic expected thumbnail paths, and
checks whether those paths exist; it never calls `identify` or `ffprobe`. Its count is therefore an
estimate, rendered with `~`, and may include a source the later MIME check rejects.

The real walk repeats the cheap filters and dispatches one bounded job per source. Before either
classification path, a candidate matching any `ignore_policies` glob (`IgnorePoliciesRepository.listGlobs()`,
same cheap in-memory pre-filter, same precedent as `update_cache`/`apply-remote-changes.ts` — see
[ignore-and-storage-policies.md](ignore-and-storage-policies.md#what-matching-actually-gates)) is skipped
outright. A real (or "both", real-with-dangling-stub) entry is then MIME-probed and policy-resolved
inside its bounded job. That same job streams only the source's sibling `_thumbnail` directory and
immediately generates, reports, or deletes as the selected mode requires. A stub is reconciled without
probing. No whole-tree decision, generation-job, or existing-thumbnail collection is retained.

A "both"/real candidate reconciles **once per matching
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
regenerate entries through the same named concurrency pool used for classification — never for a stub.
On regeneration, the stale file is deleted only after its replacement has been published. `cleanup` deletes every
to-delete file, plus a stale stub preview's thumbnail
when `--delete-stale-stub-previews` was passed — deletion is cheap enough not to need its own pool
dispatch. After source processing, a final streaming thumbnail walk handles missing originals and
sources excluded by this run without building an orphan map.

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
and resize it into any output format a policy's own `output_mime` requests. This used to require a
special case (CR2 forced to `.jpg` regardless of the policy's intent, since output format used to be
inherited from the source); now that `output_mime` is always explicit, there's nothing CR2-specific left
at all — see "Naming convention" above.

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

## Resize math: `computeContainFitSize` and `computeShorterSideFitSize`

An image policy picks one of two resizing strategies (`resizing_strategy`), each backed by its own pure,
I/O-free sizing function in `src/media/thumbnail-generate.ts`, unit tested exhaustively
(`test/unit/media/thumbnail-generate.test.ts`): `fit_to_box` uses `computeContainFitSize` (below);
`resize_shorter_side` uses `computeShorterSideFitSize` — the _same_ function a video policy's own
`shorter_side` uses for one mosaic tile or one preview frame (see "Video mosaics" and "Animated previews"
below) — scaling the source so its shorter side lands on the policy's `shorter_side`, aspect ratio
otherwise preserved, no orientation concept at all (there's only one aspect ratio to preserve, unlike
fitting into a box with its own independent orientation). Both strategies feed their computed
`{width, height}` into the exact same `generateImageThumbnail` call — the generator itself is agnostic to
which strategy produced the numbers it's handed, and to which of the four `output_mime` encodings the
policy also picked (see "Two independent axes" above) — an `ImageEncoding` union parameter, one arm per
`output_mime`, carries the encoding-specific ImageMagick flags (`-quality`, `-define
png:compression-level=`, `-define webp:lossless=`, `-colors`/`-dither`).

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

There's no fixed tile box. A policy configures one `shorter_side` — the pixel length of a mosaic tile's
_shorter_ side, **not** the composed grid's — and `computeShorterSideFitSize`
(`src/media/thumbnail-generate.ts`, a pure function, no I/O) scales the source so its own shorter side
hits that value, with the longer side falling out of the source's own aspect ratio rather than being
configured independently:

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
a still image encoded per the policy's own `output_mime` (`jpeg`/`png`/`webp` — never `gif`, see "Two
independent axes" above): JPEG maps the policy's 1-100 `jpeg_quality` onto `ffmpeg`'s mjpeg `-q:v` scale
(2 = best, 31 = worst — inverted and much coarser than JPEG's own percent scale); PNG uses
`-compression_level`; WebP switches the output codec to `-c:v libwebp` with `-quality`/`-lossless`. The
frame-extraction step passes `-autorotate` explicitly (a bare boolean flag in this ffmpeg build's CLI —
confirmed directly that `-autorotate 1` misparses as two separate tokens, the flag plus a stray value
ffmpeg then tries to apply to the _output_ file instead) rather than relying on the tool's own default (on
since ffmpeg ~4.4 — see [platform-setup.md](../platform-setup.md) for the external tool version this
project is developed and tested against). Temporary per-frame PNGs live under a fresh temp directory,
always removed in a `finally`, even when generation fails partway through.

## Animated previews

`output_type = 'preview'` (renamed from `'gif'` when this policy gained `output_mime` — GIF is no longer
the only animated format) reuses stage 1 of mosaic generation completely unchanged: `frame_count` frames
sampled at the same evenly-spaced, center-of-bucket timestamps (`t_i = duration * (i + 0.5) / N`), each
scaled via `computeShorterSideFitSize` against the policy's `shorter_side` (the same field, and the same
per-frame target, a mosaic's own `shorter_side` is). Only stage 2 — what happens to the extracted PNG
frames — differs, branching on `output_mime` (`image/gif` or `image/webp`, `preview`'s only two legal
encodings):

**`image/gif`** replaces `xstack`'s single-JPEG grid composite with the standard two-pass high-quality
animated-GIF pipeline:

1. `ffmpeg -framerate <fps> -i frame-%d.png -vf palettegen=max_colors=<gifMaxColors>:reserve_transparent=0
palette.png` builds one shared color palette across every frame, capped at the policy's own
   `gif_max_colors`. A per-frame or fixed palette produces visibly banded/dithered output; sharing one
   palette across the whole sequence avoids that. `reserve_transparent=0` is hardcoded, not a policy
   field — every sampled frame is opaque, so the reserved palette slot would be pure waste.
2. `ffmpeg -framerate <fps> -i frame-%d.png -i palette.png -lavfi paletteuse=dither=<gifDither> -loop 0
out.gif` re-encodes the frame sequence against that shared palette into the final, infinitely-looping
   (`-loop 0`) GIF, using the policy's `gif_dither` mode. `paletteuse`'s `dither` values match
   `ThumbnailGifDither`'s own enum verbatim, except `bayer`, which additionally takes a `bayer_scale`
   sub-parameter with no policy field of its own — a fixed mid-range constant is used, the same
   "hardcode it, don't add a field for it" treatment `reserve_transparent` gets.

**`image/webp`** is a single pass — `-c:v libwebp_anim -quality <webpQuality> -lossless <0|1> -loop 0` —
directly on the same frame sequence; animated WebP needs no separate palette step at all.

Both branches read the same on-disk frame sequence via `ffmpeg`'s image2 demuxer (`frame-%d.png`, with
`-start_number 0` passed explicitly rather than relying on its default), at an input `fps` derived from
`frame_delay_ms` (`1000 / frameDelayMs`) — there's no separate "set this frame's on-screen delay" flag;
the muxer stores each frame's delay as however long the filtered stream says it should be on screen, so
the input framerate _is_ the delay control. `jpeg_quality`/`png_compression_level` play no role at all — a
`preview` is never a still format (see "Two independent axes" above).

**`frame_delay_ms` fidelity differs by `output_mime`, and this matters for real use.** GIF stores the
delay in its Graphics Control Extension in **centiseconds** — 10ms is the storage floor, and every
requested value rounds (`33` → 3cs → 30ms stored); most browsers additionally clamp a stored delay of 0-1cs
up to 100ms, so a very small requested delay can render far slower than asked. Animated WebP stores the
delay in its ANMF chunk in **milliseconds**, honored exactly. The CLI enforces a 20ms floor on
`--frame-delay-ms` for exactly this reason (see [thumbnail_policy.md](../cli/thumbnail_policy.md)).

Temporary per-frame PNGs (and, for GIF, the intermediate palette PNG) live under a fresh temp directory,
always removed in a `finally`, same discipline as a mosaic's own frame directory.

## Parallelism

Classification (filesystem walk + mime probe + policy resolution) and generation both dispatch through
the same named pool, `pools.thumbnail` (a fourth `PQueue` alongside the existing three — see
[concurrency-and-progress.md](concurrency-and-progress.md)), sized by the global `--thumbnail-parallelism`
flag (default 4). This command deliberately stays on the plain item-count `ProgressSession` (see
concurrency-and-progress.md's "Progress bars and `--verbose`" section), not the combined files+bytes+ETA
`BytesProgressSession` used by `update_cache`/`sync`/`materialize`/`stubify`/`sanity_check`, since
thumbnail generation isn't a byte-transfer/hash operation -- "files processed" is the natural progress
unit for this command.

All three modes use one source file as the progress unit, even when several policies produce several
outputs for it. The advisory walk supplies the provisional denominator; the real walk raises that total
as it discovers work and advances the numerator in each job's `finally`, including MIME/skip rejection
and handled generation failure. Once all source and orphan work settles, the observed total replaces the
estimate and the `~` disappears. `processing`/`processed` activity is shown for classification-only work;
actual generation shows `generating <path>` and `generated <path>` immediately beside the bar.

Generation never writes directly to the deterministic thumbnail path. Each image, mosaic, or preview is
written to an extension-preserving `sync1-tmp` sibling so ImageMagick/ffmpeg still infer the requested
format, then atomically renamed into place. A failed generation removes its temp file and leaves any stale
predecessor intact; an abrupt process exit can leave only a temp sibling, which filesystem walks ignore.
