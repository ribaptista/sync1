# `sync1 thumbnail_policy`

Manages **global thumbnail-generation policies**: a glob pattern (real `**` support — see
[thumbnails.md](../architecture/thumbnails.md)) paired with a mime-type filter and a `skip`/`generate`
disposition. Like `storage_policy`/`ignore`, these live in `state.db` — shared and versioned, so every
machine agrees on the same rules. Unlike `storage_policy`, there is **no mandatory default row**: a path
matching no policy at all is simply not a thumbnail candidate. `sync1 thumbnail state/ensure/cleanup`
apply these policies; `thumbnail_policy` only manages the rules themselves.

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
sync1 thumbnail_policy list --root <local-path> [--json]

sync1 thumbnail_policy create <glob> <skip|generate> --root <local-path> \
  --mime-types <csv> \
  [--priority <n>] \
  [--image-width <n>] [--image-height <n>] \
  [--tile-rows <n>] [--tile-columns <n>] [--tile-width <n>] [--tile-height <n>] \
  [--jpeg-quality <1-100>] \
  [--json]

sync1 thumbnail_policy edit <id> --root <local-path> \
  [--glob <glob>] [--action <skip|generate>] [--mime-types <csv>] [--priority <n>] \
  [--image-width <n>] [--image-height <n>] \
  [--tile-rows <n>] [--tile-columns <n>] [--tile-width <n>] [--tile-height <n>] \
  [--jpeg-quality <1-100>] \
  [--json]

sync1 thumbnail_policy delete <id> --root <local-path> [--json]
```

`--mime-types` is a comma-separated list, e.g. `"image/jpeg,video/*"` — the subtype half of any entry may
be a literal `*` wildcard, nothing else is a wildcard here. Required on `create` (even for a `skip`
policy — mime type still gates what a skip actually applies to).

`create`/`edit` validate the `skip`/`generate` combination before touching the network: a `skip` policy
must not set `--priority` or any of the six generation flags; a `generate` policy must set all six
(`--image-width`, `--image-height`, `--tile-rows`, `--tile-columns`, `--tile-width`, `--tile-height`,
`--jpeg-quality`) on `create` — `--priority`, if omitted, auto-assigns to run after every existing
`generate` policy (lower numbers are checked first among matching `generate` rows; irrelevant among
`skip` rows, which always win outright regardless of priority). `edit` re-validates the _merged_ result,
so flipping `--action generate` to `--action skip` (or back) in the same call must also supply/clear the
relevant fields as needed.

## Output

```json
{
  "ok": true,
  "policies": [
    {
      "id": 1,
      "glob": "**/*.jpg",
      "action": "generate",
      "priority": 0,
      "mimeTypes": ["image/jpeg"],
      "imageWidth": 320,
      "imageHeight": 240,
      "tileRowCount": 4,
      "tileColumnCount": 4,
      "tileWidth": 160,
      "tileHeight": 90,
      "jpegQuality": 80,
      "createdAt": "2026-01-01T00:00:00.000Z"
    },
    {
      "id": 2,
      "glob": "private/**",
      "action": "skip",
      "priority": null,
      "mimeTypes": ["image/*", "video/*"],
      "imageWidth": null,
      "imageHeight": null,
      "tileRowCount": null,
      "tileColumnCount": null,
      "tileWidth": null,
      "tileHeight": null,
      "jpegQuality": null,
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

## Exit codes

- `0` — success.
- `1` — the root isn't initialized/attached, an invalid glob/action/mime-type/priority/dimension was
  given, the `skip`/`generate` field combination was inconsistent, or `edit`/`delete` referenced an id
  that doesn't exist.

## Example

```bash
sync1 thumbnail_policy create "**/*.jpg" generate --root ~/Pictures \
  --mime-types image/jpeg --image-width 320 --image-height 240 \
  --tile-rows 4 --tile-columns 4 --tile-width 160 --tile-height 90 --jpeg-quality 80 --json

sync1 thumbnail_policy create "private/**" skip --root ~/Pictures --mime-types "image/*,video/*" --json

sync1 thumbnail_policy list --root ~/Pictures --json
```
