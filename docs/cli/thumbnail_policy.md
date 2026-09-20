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

## Usage

```bash
sync1 thumbnail_policy list [--root <local-path>] [--json]

sync1 thumbnail_policy create <glob> <skip|generate> [--root <local-path>] \
  --name <name> \
  --mime-types <csv> \
  --media-type <image|video> \
  [--image-width <n>] [--image-height <n>] \
  [--tile-rows <n>] [--tile-columns <n>] [--tile-size <n>] \
  [--jpeg-quality <1-100>] \
  [--json]

sync1 thumbnail_policy edit <id> [--root <local-path>] \
  [--name <name>] \
  [--glob <glob>] [--action <skip|generate>] [--mime-types <csv>] \
  [--media-type <image|video>] \
  [--image-width <n>] [--image-height <n>] \
  [--tile-rows <n>] [--tile-columns <n>] [--tile-size <n>] \
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

Every `generate` row is **either an image policy or a video policy**, via `--media-type`, and only ever
carries the fields relevant to its own type — no nonsense tile fields on an image-only policy, no
image-box fields on a video-only one. `--tile-size` is a single value (the pixel length of a mosaic
tile's _shorter_ side, not a fixed box — see [thumbnails.md](../architecture/thumbnails.md#video-mosaics))
replacing what used to be separate `--tile-width`/`--tile-height` flags.

`create`/`edit` validate the `skip`/`generate`/media-type combination before touching the network: a
`skip` policy must not set `--media-type` or any of the five generation flags; a `generate` policy must
set `--media-type` plus every field belonging to that type (`--image-width`, `--image-height`,
`--jpeg-quality` for `image`; `--tile-rows`, `--tile-columns`, `--tile-size`, `--jpeg-quality` for
`video`) and none of the other type's fields. `edit` re-validates the _merged_ result, so switching
`--action generate` to `--action skip` (or back), or switching `--media-type` from `image` to `video`
(or back) on an existing `generate` row, must also supply/clear the relevant fields as needed — a
media-type switch also requires resupplying `--mime-types` to match the new type. The one field that
survives an `image`↔`video` switch without needing to be resupplied is `--jpeg-quality`, the single
field both `generate` branches share.

## Output

A `generate` row's shape depends on its `mediaType` — an `image` row never carries the three `tile*`
fields, and a `video` row never carries `imageWidth`/`imageHeight`; both always carry `jpegQuality`. A
`skip` row carries none of them, and no `mediaType` at all. Every row always carries `name`:

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
      "mimeTypes": ["video/*"],
      "tileRowCount": 4,
      "tileColumnCount": 4,
      "tileSize": 90,
      "jpegQuality": 80,
      "createdAt": "2026-01-01T00:00:00.000Z"
    },
    {
      "id": 3,
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
- `1` — the root isn't initialized/attached, an invalid glob/action/media-type/mime-type/name/dimension
  was given, the name was already taken, the `skip`/`generate`/media-type field combination was
  inconsistent, or `edit`/`delete` referenced an id that doesn't exist.

## Example

```bash
sync1 thumbnail_policy create "**/*.jpg" generate --root ~/Pictures \
  --name photo_thumb --mime-types image/jpeg --media-type image \
  --image-width 320 --image-height 240 --jpeg-quality 80 --json

sync1 thumbnail_policy create "**/*.mp4" generate --root ~/Pictures \
  --name video_mosaic --mime-types video/* --media-type video \
  --tile-rows 4 --tile-columns 4 --tile-size 90 --jpeg-quality 80 --json

sync1 thumbnail_policy create "private/**" skip --root ~/Pictures \
  --name skip_private --mime-types "image/*,video/*" --json

sync1 thumbnail_policy list --root ~/Pictures --json
```
