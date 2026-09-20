# `sync1 fetch_remote`

Pulls the latest state.db snapshot from the remote vault into the local `.sync1/state.db` — nothing
else. No filesystem changes, no `cache.db` changes, and it doesn't advance `last_synced_version` (that
file records what this machine has actually _synced_ — folded its own local changes into — not merely
peeked at; `sync` is what advances it).

Note that `sync` already does this fetch internally as part of its own bidirectional merge whenever the
remote has moved on, so you don't need to run `fetch_remote` before `sync` — it's for when you just want
to see the latest remote state (e.g. for inspecting it, or for tooling built on top of `inspect`) without
touching the local filesystem or committing anything.

## Usage

```bash
sync1 fetch_remote [--root <local-path>] [--json] [--verbose]
```

## Options

| Flag            | Required | Description                                                                                                                                                                             |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--root <path>` | no       | Local directory whose vault to fetch. Must already be initialized or attached. Defaults to the nearest ancestor directory with a `.sync1/`, searched from the current directory upward. |

## Output

```json
{ "ok": true, "version_stamp": "20260101T020000000Z-a1b2c3d4" }
```

## Exit codes

- `0` — success.
- `1` — wrong password, no vault/pointer found, or an S3/network error. A wrong password is rejected
  before anything is written, so a failed `fetch_remote` never leaves local state.db in a partially
  overwritten state.

## Example

```bash
SYNC1_PASSWORD='correct horse battery staple' sync1 fetch_remote --root ~/Pictures --json
# or, run from anywhere inside ~/Pictures:
SYNC1_PASSWORD='correct horse battery staple' sync1 fetch_remote --json
```
