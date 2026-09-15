# `sync1 ignore`

Manages **global ignore policies**: [glob patterns](../README.md#glob-syntax) for paths that should never
enter the vault at all. Unlike `cache.db`, ignore policies live in `state.db` — shared and versioned, so every machine
backing up the same vault agrees on the same rules. See
[ignore-and-storage-policies.md](../architecture/ignore-and-storage-policies.md) for the full design.

## Subcommands

| Subcommand                | Password? | Description                           |
| ------------------------- | --------- | ------------------------------------- |
| `ignore list`             | no        | Lists every ignore policy.            |
| `ignore create <glob>`    | yes       | Adds a new ignore policy.             |
| `ignore edit <id> <glob>` | yes       | Changes an existing policy's pattern. |
| `ignore delete <id>`      | yes       | Removes a policy.                     |

`list` reads the already-locally-synced (decrypted) copy of `state.db` directly, so it needs no
password. `create`/`edit`/`delete` mutate shared state, so each is a real commit (new state.db version,
uploaded, CAS'd against `/current`) and needs `SYNC1_PASSWORD` (or an interactive prompt).

## Usage

```bash
sync1 ignore list --root <local-path> [--json]
sync1 ignore create <glob> --root <local-path> [--json]
sync1 ignore edit <id> <glob> --root <local-path> [--json]
sync1 ignore delete <id> --root <local-path> [--json]
```

## What matching a policy actually does

- **A new local file** discovered by `update_cache` (or `sync`'s internal scan) matching any ignore
  policy is skipped silently — never staged into `cache.db` at all, just a debug log line — but the
  count is still reported (`update_cache`'s `ignored` field).
- **A remote path arriving for the first time** on a machine, if it happens to match an ignore policy,
  is still materialized as usual — ignore policies gate new _local_ creations, they never retroactively
  un-share content some other machine already committed to the vault. `sync` surfaces this instead as a
  warning (`ignored_but_synced`), with no effect on its exit code.
- Ignore policies are a monotonic OR — any matching pattern means ignored, there's no priority/precedence
  concept the way storage-class policies have.

## Output

```json
{ "ok": true, "policies": [{ "id": 1, "glob": "*.tmp", "created_at": "2026-01-01T00:00:00.000Z" }] }
```

`create` additionally returns `{ "ok": true, "id": <new id> }`.

## Exit codes

- `0` — success.
- `1` — the root isn't initialized/attached, `edit`/`delete` referenced an id that doesn't exist, or (rare)
  a concurrent commit from another machine kept landing between this command's read and its CAS attempt
  until the automatic retry budget ran out (see
  [garbage-collection-scope.md](../architecture/garbage-collection-scope.md) for the same CAS-retry
  pattern `gc` uses, which `ignore`'s mutations share).

## Example

```bash
sync1 ignore create "*.tmp" --root ~/Pictures --json
sync1 ignore list --root ~/Pictures --json
```
