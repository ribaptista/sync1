# `sync1 thumbnail_policy`

Manages **global thumbnail-generation policies**: a glob pattern (real `**` support — see
[thumbnails.md](../architecture/thumbnails.md)) paired with a mime-type filter and a `skip`/`generate`
disposition. Like `storage_policy`/`ignore`, these live in `state.db` — shared and versioned, so every
machine agrees on the same rules. Unlike `storage_policy`, there is **no mandatory default row**: a path
matching no policy at all is simply not a thumbnail candidate. Unlike `storage_policy`, there is also
**no priority**: every matching `generate` policy produces its own thumbnail, not just the "best" one —
see [thumbnails.md](../architecture/thumbnails.md#thumbnail_policy-deciding-what-gets-a-thumbnail).
`sync1 thumbnail state/ensure/cleanup` apply these policies; `thumbnail_policy` only manages the rules
themselves.

## Subcommands

| Subcommand                                        | Password? | Description                            |
| ------------------------------------------------- | --------- | -------------------------------------- |
| `thumbnail_policy list`                           | no        | Lists every policy, in creation order. |
| `thumbnail_policy create <glob> <skip\|generate>` | yes       | Adds a new policy.                     |
| `thumbnail_policy edit <id>`                      | yes       | Changes an existing policy's fields.   |
| `thumbnail_policy delete <id>`                    | yes       | Removes a policy.                      |

`list` reads the already-locally-synced (decrypted) copy of `state.db` directly, so it needs no password.
`create`/`edit`/`delete` mutate shared state, so each is a real commit (new state.db version, uploaded,
CAS'd against `/current`) and needs `SYNC1_PASSWORD` (or an interactive prompt).

## Two independent axes: sizing and encoding

A `generate` policy's fields split into two axes that never interact except at one legality check (see
the table below): **sizing** (how many pixels the output has) and **encoding** (how those pixels are
compressed). Every `generate` policy picks exactly one sizing branch and exactly one encoding, and
`--output-mime` is **always required** — there is no format inheritance from the original file.

**Sizing** — an image policy picks `--resizing-strategy`, a video policy picks `--output-type`:

| `--media-type` | branch flag                               | required fields                                       |
| -------------- | ----------------------------------------- | ----------------------------------------------------- |
| `image`        | `--resizing-strategy fit_to_box`          | `--image-width`, `--image-height`                     |
| `image`        | `--resizing-strategy resize_shorter_side` | `--shorter-side`                                      |
| `video`        | `--output-type mosaic`                    | `--tile-rows`, `--tile-columns`, `--shorter-side`     |
| `video`        | `--output-type preview`                   | `--shorter-side`, `--frame-count`, `--frame-delay-ms` |

`--shorter-side` means **one output unit's own shorter side**, not the composed grid's: for an image or a
preview frame that's the produced file's own shorter side, but for a `mosaic` it's **one tile's** — a
`--shorter-side 90` mosaic on a 3×4 grid composes to roughly 270×(4× the derived long side), not a
90-ish image. It's shared by every branch except `fit_to_box`, which is why an `edit` switching between
those three branches (e.g. `mosaic` ↔ `preview`, or `resize_shorter_side` ↔ any video branch) carries the
value straight over instead of dropping it.

**Encoding** — every branch picks `--output-mime`, then that mime's own fields:

| `--output-mime` | required fields                     | default (when omitted on `create`) |
| --------------- | ----------------------------------- | ---------------------------------- |
| `image/jpeg`    | `--jpeg-quality`                    | none — always required             |
| `image/png`     | `--png-compression-level`           | `9`                                |
| `image/webp`    | `--webp-quality`, `--webp-lossless` | `80`, `false`                      |
| `image/gif`     | `--gif-max-colors`, `--gif-dither`  | `256`, `sierra2_4a`                |

Defaults are applied **only on `create`**, and only in the CLI layer — the stored row is always fully
concrete (never relies on a database-side default), which is what lets the thumbnail filename segment
always reflect exactly what was used. `edit` never applies a default: an omitted encoding field either
carries over from the existing row (when the branch/mime is unchanged) or must be supplied explicitly
(when it changed) — see the "carries" rule below.

**Which encodings are legal for which sizing branch** — the one place the two axes meet:

| sizing branch                                    | legal `--output-mime` values                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `fit_to_box` / `resize_shorter_side` (any image) | `image/jpeg`, `image/png`, `image/webp`, `image/gif`                                                                         |
| `mosaic`                                         | `image/jpeg`, `image/png`, `image/webp` — never `image/gif` (a one-frame "animation" is strictly worse than any alternative) |
| `preview`                                        | `image/gif`, `image/webp` — never a still format (always animated)                                                           |

`--frame-delay-ms` has a floor of **20ms** — below that, GIF's own centisecond-granularity storage and
most browsers' clamping of a near-zero stored delay make the requested delay meaningless. GIF also
rounds any delay to the nearest 10ms when stored (`33` → 30ms); animated WebP stores the value exactly.

`create`/`edit` validate the `skip`/`generate`/media-type/sizing-branch/encoding combination before
touching the network: a `skip` policy must not set `--media-type`, `--resizing-strategy`, `--output-type`,
`--output-mime`, or any generation/encoding flag; a `generate` policy must set `--media-type`, then (for
`image`) `--resizing-strategy` or (for `video`) `--output-type`, then `--output-mime` (legal for that
sizing branch), then exactly that branch's own sizing and encoding fields and none of the other
branches'/mimes'. `edit` re-validates the _merged_ result, so switching `--action generate` to
`--action skip` (or back), switching `--media-type` (image↔video), switching `--resizing-strategy`/
`--output-type` within a media type, or switching `--output-mime`, must also supply/clear the relevant
fields as needed — a media-type switch also requires resupplying `--mime-types` to match the new type. A
field survives a branch switch whenever the _new_ branch also uses it: `--shorter-side` survives any
switch except one landing on `fit_to_box`; an encoding field (`--jpeg-quality`, etc.) survives any switch
that leaves `--output-mime` unchanged.

## Usage

```bash
sync1 thumbnail_policy list [--root <local-path>] [--json]

sync1 thumbnail_policy create <glob> <skip|generate> [--root <local-path>] \
  --name <name> \
  --mime-types <csv> \
  --media-type <image|video> \
  [--resizing-strategy <fit_to_box|resize_shorter_side>] \
  [--image-width <n>] [--image-height <n>] [--shorter-side <n>] \
  [--output-type <mosaic|preview>] \
  [--tile-rows <n>] [--tile-columns <n>] \
  [--frame-count <n>] [--frame-delay-ms <n>] \
  --output-mime <image/jpeg|image/png|image/webp|image/gif> \
  [--jpeg-quality <1-100>] \
  [--png-compression-level <0-9>] \
  [--webp-quality <1-100>] [--webp-lossless <true|false>] \
  [--gif-max-colors <2-256>] [--gif-dither <name>] \
  [--json]

sync1 thumbnail_policy edit <id> [--root <local-path>] \
  [--name <name>] \
  [--glob <glob>] [--action <skip|generate>] [--mime-types <csv>] \
  [--media-type <image|video>] \
  [--resizing-strategy <fit_to_box|resize_shorter_side>] \
  [--image-width <n>] [--image-height <n>] [--shorter-side <n>] \
  [--output-type <mosaic|preview>] \
  [--tile-rows <n>] [--tile-columns <n>] \
  [--frame-count <n>] [--frame-delay-ms <n>] \
  [--output-mime <image/jpeg|image/png|image/webp|image/gif>] \
  [--jpeg-quality <1-100>] \
  [--png-compression-level <0-9>] \
  [--webp-quality <1-100>] [--webp-lossless <true|false>] \
  [--gif-max-colors <2-256>] [--gif-dither <name>] \
  [--json]

sync1 thumbnail_policy delete <id> [--root <local-path>] [--json]
```

`--gif-dither` accepts `none`, `bayer`, `heckbert`, `floyd_steinberg`, `sierra2`, `sierra2_4a`, `sierra3`,
`burkes`, or `atkinson` — ffmpeg's full dithering enum, used verbatim for a `preview` (video) policy's
animated-GIF output. A still-image `generate` policy using `image/gif` maps this down to ImageMagick's
only comparable option: `none` stays `none`, everything else becomes ordinary Floyd-Steinberg
error-diffusion dithering — the stored value is exact for video, approximate for the still-image path.

`--root` is optional on every subcommand — omitted, it defaults to the nearest ancestor directory
containing a `.sync1/`, searched from the current directory upward.

`--name` is required on `create` and, unlike every other field, has nothing to do with matching: it's a
unique identifier (letters, digits, and underscores only, enforced by a `CHECK` constraint plus a
`UNIQUE` index — a duplicate name is rejected as a raw database constraint error) that appears verbatim
in every thumbnail this policy generates (see [thumbnails.md](../architecture/thumbnails.md#naming-convention-and-where-thumbnails-live)).
It exists so two policies matching the same file never collide on disk, and doubles as how
reconciliation recognizes "this policy's own previous output" versus another policy's or a genuine
orphan — which also means renaming a policy (`edit --name`) is indistinguishable, on disk, from
replacing it: the next `ensure` regenerates under the new name, and the next `cleanup` removes the old
name's now-orphaned file.

`--mime-types` is a comma-separated list, e.g. `"image/jpeg,video/*"` — the subtype half of any entry may
be a literal `*` wildcard, nothing else is a wildcard here. Required on `create` (even for a `skip`
policy — mime type still gates what a skip actually applies to). For a `generate` policy, every entry's
_type_ segment (`image`/`video`, never wildcarded) must match `--media-type` — `image/jpeg,video/*` is
never valid on the same `generate` row, since a `generate` policy is always exactly one media type or the
other, never both (a `skip` row has no such restriction: it legitimately mixes types, e.g.
`image/*,video/*`, since matching a skip never needs to know a media type at all). This is entirely about
the _source_ mime filter, unrelated to `--output-mime`, which is what a `generate` policy _produces_.

## Output

A `generate` row's shape depends on its `mediaType` and, within that, its `resizingStrategy`/`outputType`
(sizing) plus its `outputMime` (encoding) — each combination carries only its own fields (see the tables
above). A `skip` row carries none of them, and no `mediaType`/`outputMime` at all. Every row always
carries `name`:

```json
{
  "ok": true,
  "policies": [
    {
      "id": 1,
      "name": "photo_thumb",
      "glob": "**/*.jpg",
      "action": "generate",
      "mediaType": "image",
      "resizingStrategy": "fit_to_box",
      "mimeTypes": ["image/jpeg"],
      "imageWidth": 320,
      "imageHeight": 240,
      "outputMime": "image/jpeg",
      "jpegQuality": 80,
      "createdAt": "2026-01-01T00:00:00.000Z"
    },
    {
      "id": 2,
      "name": "video_mosaic",
      "glob": "**/*.mp4",
      "action": "generate",
      "mediaType": "video",
      "outputType": "mosaic",
      "mimeTypes": ["video/*"],
      "tileRowCount": 4,
      "tileColumnCount": 4,
      "shorterSide": 90,
      "outputMime": "image/webp",
      "webpQuality": 80,
      "webpLossless": false,
      "createdAt": "2026-01-01T00:00:00.000Z"
    },
    {
      "id": 3,
      "name": "video_preview",
      "glob": "**/*.mp4",
      "action": "generate",
      "mediaType": "video",
      "outputType": "preview",
      "mimeTypes": ["video/*"],
      "shorterSide": 64,
      "frameCount": 8,
      "frameDelayMs": 100,
      "outputMime": "image/gif",
      "gifMaxColors": 256,
      "gifDither": "sierra2_4a",
      "createdAt": "2026-01-01T00:00:00.000Z"
    },
    {
      "id": 4,
      "name": "skip_private",
      "glob": "private/**",
      "action": "skip",
      "mimeTypes": ["image/*", "video/*"],
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

## Exit codes

- `0` — success.
- `1` — the root isn't initialized/attached, an invalid glob/action/media-type/resizing-strategy/
  output-type/output-mime/mime-type/name/dimension/dither value was given, the name was already taken,
  the `skip`/`generate`/branch/encoding field combination was inconsistent (including an encoding illegal
  for the chosen sizing branch, e.g. `image/gif` on a `mosaic`), or `edit`/`delete` referenced an id that
  doesn't exist.

## Example

```bash
sync1 thumbnail_policy create "**/*.jpg" generate --root ~/Pictures \
  --name photo_thumb --mime-types image/jpeg --media-type image \
  --resizing-strategy fit_to_box \
  --image-width 320 --image-height 240 \
  --output-mime image/jpeg --jpeg-quality 80 --json

sync1 thumbnail_policy create "**/*.jpg" generate --root ~/Pictures \
  --name photo_thumb_webp --mime-types image/jpeg --media-type image \
  --resizing-strategy resize_shorter_side \
  --shorter-side 150 \
  --output-mime image/webp --webp-quality 80 --webp-lossless false --json

sync1 thumbnail_policy create "**/*.mp4" generate --root ~/Pictures \
  --name video_mosaic --mime-types video/* --media-type video \
  --output-type mosaic \
  --tile-rows 4 --tile-columns 4 --shorter-side 90 \
  --output-mime image/png --png-compression-level 9 --json

sync1 thumbnail_policy create "**/*.mp4" generate --root ~/Pictures \
  --name video_preview --mime-types video/* --media-type video \
  --output-type preview \
  --shorter-side 64 --frame-count 8 --frame-delay-ms 100 \
  --output-mime image/gif --gif-max-colors 256 --gif-dither sierra2_4a --json

sync1 thumbnail_policy create "private/**" skip --root ~/Pictures \
  --name skip_private --mime-types "image/*,video/*" --json

sync1 thumbnail_policy list --root ~/Pictures --json
```
