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

## The four `generate` branches

A `generate` policy is always exactly one of four branches — an image policy picks a
`--resizing-strategy`, a video policy picks an `--output-type` — each with its own required fields:

| `--media-type` | branch flag                               | required fields                                    |
| -------------- | ----------------------------------------- | -------------------------------------------------- |
| `image`        | `--resizing-strategy fit_to_box`          | `--image-width`, `--image-height`                  |
| `image`        | `--resizing-strategy resize_shorter_side` | `--shorter-side`                                   |
| `video`        | `--output-type mosaic`                    | `--tile-rows`, `--tile-columns`, `--tile-size`     |
| `video`        | `--output-type gif`                       | `--tile-size`, `--frame-count`, `--frame-delay-ms` |

`--jpeg-quality` is required for every branch **except** `gif` — a GIF is never JPEG-encoded, so it has no
quality setting to configure. `--tile-size` means "one mosaic tile's shorter side" for `mosaic` and "one
GIF frame's shorter side" for `gif` — the same flag and column, deliberately reused rather than
duplicated (see [thumbnails.md](../architecture/thumbnails.md#video-mosaics)); it's what lets an
`edit --output-type gif` on an existing mosaic policy carry the same tile size straight over.

## Usage

```bash
sync1 thumbnail_policy list [--root <local-path>] [--json]

sync1 thumbnail_policy create <glob> <skip|generate> [--root <local-path>] \
  --name <name> \
  --mime-types <csv> \
  --media-type <image|video> \
  [--resizing-strategy <fit_to_box|resize_shorter_side>] \
  [--image-width <n>] [--image-height <n>] [--shorter-side <n>] \
  [--output-type <mosaic|gif>] \
  [--tile-rows <n>] [--tile-columns <n>] [--tile-size <n>] \
  [--frame-count <n>] [--frame-delay-ms <n>] \
  [--jpeg-quality <1-100>] \
  [--json]

sync1 thumbnail_policy edit <id> [--root <local-path>] \
  [--name <name>] \
  [--glob <glob>] [--action <skip|generate>] [--mime-types <csv>] \
  [--media-type <image|video>] \
  [--resizing-strategy <fit_to_box|resize_shorter_side>] \
  [--image-width <n>] [--image-height <n>] [--shorter-side <n>] \
  [--output-type <mosaic|gif>] \
  [--tile-rows <n>] [--tile-columns <n>] [--tile-size <n>] \
  [--frame-count <n>] [--frame-delay-ms <n>] \
  [--jpeg-quality <1-100>] \
  [--json]

sync1 thumbnail_policy delete <id> [--root <local-path>] [--json]
```

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
`image/*,video/*`, since matching a skip never needs to know a media type at all).

`create`/`edit` validate the `skip`/`generate`/media-type/branch combination before touching the network:
a `skip` policy must not set `--media-type`, `--resizing-strategy`, `--output-type`, or any generation
flag; a `generate` policy must set `--media-type`, then (for `image`) `--resizing-strategy` or (for
`video`) `--output-type`, then exactly that branch's own fields (see the table above) and none of the
other branches'. `edit` re-validates the _merged_ result, so switching `--action generate` to
`--action skip` (or back), switching `--media-type` (image↔video), or switching `--resizing-strategy`/
`--output-type` within a media type, must also supply/clear the relevant fields as needed — a media-type
switch also requires resupplying `--mime-types` to match the new type. A field survives a branch switch
whenever the _new_ branch also uses it: `--jpeg-quality` survives any switch except one landing on `gif`;
`--tile-size` survives a `mosaic`↔`gif` switch specifically, since both use it.

## Output

A `generate` row's shape depends on its `mediaType` and, within that, its `resizingStrategy`/`outputType`
— each of the four branches carries only its own fields (see the table above). A `skip` row carries none
of them, and no `mediaType` at all. Every row always carries `name`:

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
      "tileSize": 90,
      "jpegQuality": 80,
      "createdAt": "2026-01-01T00:00:00.000Z"
    },
    {
      "id": 3,
      "name": "video_gif",
      "glob": "**/*.mp4",
      "action": "generate",
      "mediaType": "video",
      "outputType": "gif",
      "mimeTypes": ["video/*"],
      "tileSize": 64,
      "frameCount": 8,
      "frameDelayMs": 100,
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
  output-type/mime-type/name/dimension was given, the name was already taken, the
  `skip`/`generate`/branch field combination was inconsistent, or `edit`/`delete` referenced an id that
  doesn't exist.

## Example

```bash
sync1 thumbnail_policy create "**/*.jpg" generate --root ~/Pictures \
  --name photo_thumb --mime-types image/jpeg --media-type image \
  --resizing-strategy fit_to_box \
  --image-width 320 --image-height 240 --jpeg-quality 80 --json

sync1 thumbnail_policy create "**/*.jpg" generate --root ~/Pictures \
  --name photo_thumb_wide --mime-types image/jpeg --media-type image \
  --resizing-strategy resize_shorter_side \
  --shorter-side 150 --jpeg-quality 80 --json

sync1 thumbnail_policy create "**/*.mp4" generate --root ~/Pictures \
  --name video_mosaic --mime-types video/* --media-type video \
  --output-type mosaic \
  --tile-rows 4 --tile-columns 4 --tile-size 90 --jpeg-quality 80 --json

sync1 thumbnail_policy create "**/*.mp4" generate --root ~/Pictures \
  --name video_gif --mime-types video/* --media-type video \
  --output-type gif \
  --tile-size 64 --frame-count 8 --frame-delay-ms 100 --json

sync1 thumbnail_policy create "private/**" skip --root ~/Pictures \
  --name skip_private --mime-types "image/*,video/*" --json

sync1 thumbnail_policy list --root ~/Pictures --json
```
