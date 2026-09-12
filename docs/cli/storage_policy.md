# `sync1 storage_policy`

Manages **global storage-class policies**: SQLite `GLOB` patterns mapped to a target S3 storage class,
with an explicit priority resolving which policy wins when more than one non-default glob matches the
same path. Like `ignore` policies, these live in `state.db` — shared and versioned, so every machine
agrees on the same rules. `status`/`converge` (a later task) apply these policies; `storage_policy` only
manages the rules themselves. See
[ignore-and-storage-policies.md](../architecture/ignore-and-storage-policies.md) for the shared design
this builds on, and the forthcoming `storage-class-policies.md` for the priority/default/warmest-wins
design specifically.

## Subcommands

| Subcommand                             | Password? | Description                                                 |
| -------------------------------------- | --------- | ----------------------------------------------------------- |
| `storage_policy list`                  | no        | Lists every policy (non-default by priority, default last). |
| `storage_policy create <glob> <class>` | yes       | Adds a new non-default policy.                              |
| `storage_policy edit <id>`             | yes       | Changes an existing policy's glob/class/priority.           |
| `storage_policy delete <id>`           | yes       | Removes a non-default policy.                               |

`list` reads the already-locally-synced (decrypted) copy of `state.db` directly, so it needs no
password. `create`/`edit`/`delete` mutate shared state, so each is a real commit (new state.db version,
uploaded, CAS'd against `/current`, via the same generic helper `ignore create/edit/delete` uses) and
needs `SYNC1_PASSWORD` (or an interactive prompt).

## The default policy

Every vault always has exactly one **default policy** (`STANDARD`, seeded when the vault is created) —
the catch-all for any path no other policy's glob matches. It has no glob and no priority: it's
structurally always the last resort, never part of the priority ordering used to resolve overlapping
non-default policies. Only its `target_class` can ever be changed (`storage_policy edit <id> --class
<class>`); its glob/priority are fixed, and it can never be deleted.

## Usage

```bash
sync1 storage_policy list --root <local-path> [--json]
sync1 storage_policy create <glob> <class> [--priority <n>] --root <local-path> [--json]
sync1 storage_policy edit <id> [--glob <glob>] [--class <class>] [--priority <n>] --root <local-path> [--json]
sync1 storage_policy delete <id> --root <local-path> [--json]
```

`<class>`/`--class` accepts `STANDARD`, `GLACIER`, or `DEEP_ARCHIVE`. `--priority`, when omitted on
`create`, is auto-assigned to run after every existing non-default policy (still ahead of the default) —
lower numbers are checked first among non-default policies.

## Output

```json
{
  "ok": true,
  "policies": [
    {
      "id": 2,
      "glob": "archive/*",
      "target_class": "DEEP_ARCHIVE",
      "priority": 0,
      "is_default": 0
    },
    { "id": 1, "glob": null, "target_class": "STANDARD", "priority": null, "is_default": 1 }
  ]
}
```

## Exit codes

- `0` — success.
- `1` — the root isn't initialized/attached, an unsupported storage class was given, `edit`/`delete`
  referenced an id that doesn't exist, or an edit/delete tried to touch the default policy's glob,
  priority, or existence.

## Example

```bash
sync1 storage_policy create "archive/*" DEEP_ARCHIVE --root ~/Pictures --json
sync1 storage_policy list --root ~/Pictures --json
```
