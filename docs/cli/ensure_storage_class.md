# `sync1 ensure_storage_class`

Moves objects matching a glob pattern to a target S3 storage class — for archiving rarely-touched
content to cheaper storage, or bringing it back when you need it.

## Usage

```bash
sync1 ensure_storage_class <glob> <class> --root <local-path> [--apply] [--json] [--verbose]
```

## Arguments

| Argument  | Description                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------- |
| `<glob>`  | SQLite `GLOB` pattern matched against tracked paths in the local state.db (e.g. `photos/2020/*`). |
| `<class>` | Target storage class: `STANDARD`, `GLACIER`, or `DEEP_ARCHIVE` — no others are supported.         |

## Options

| Flag            | Required | Description                                                                                                              |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--root <path>` | yes      | Local directory whose vault to operate on.                                                                               |
| `--apply`       | no       | Actually perform the changes. Without it, the command only counts what _would_ happen — the same safety default as `gc`. |

No password is needed — this command never touches encrypted content, only S3 object metadata.

## What it does

Resolves the glob against **distinct content hashes**, not paths — moving to a colder class is
immediate (a self-copy); moving to a warmer class needs a restore first if the object is currently
archived:

- **Colder target** (e.g. `STANDARD` → `DEEP_ARCHIVE`): immediate `CopyObject` with the new storage
  class.
- **Warmer target** (e.g. `DEEP_ARCHIVE` → `STANDARD`) on an object with no restore requested yet:
  issues a temporary restore request (`RestoreObject`).
- Same, but a restore is already in progress: nothing to do yet, counted as pending.
- Same, but the restore has completed: issues the finalizing `CopyObject` that actually changes the
  permanent storage class.

**Dedup interaction**: since storage class is a property of the underlying object (by content hash),
changing it affects _every_ path that references that hash — including ones outside the glob you
passed, if they happen to share identical content with a matched path.

## Output

```json
{
  "ok": true,
  "applied": true,
  "already_correct": 3,
  "changed_immediate": 1,
  "restore_requested": 0,
  "restore_pending": 0,
  "finalized": 0
}
```

## Exit codes

- `0` — success.
- `1` — unsupported storage class name, missing/corrupt state.db entries, or an S3/network error.

## Example

```bash
# see what would change (no --apply)
sync1 ensure_storage_class "photos/2020/*" DEEP_ARCHIVE --root ~/Pictures --json

# actually archive it
sync1 ensure_storage_class "photos/2020/*" DEEP_ARCHIVE --root ~/Pictures --apply --json

# bring it back later
sync1 ensure_storage_class "photos/2020/*" STANDARD --root ~/Pictures --apply --json
```
