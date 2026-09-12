# `sync1 status`

A read-only report comparing every tracked object's actual S3 storage class against what
`storage_policy` implies it should be. `converge` (a later command) applies the same evaluation instead
of just counting it — `status` is the count-only, always-safe-to-run half.

## Usage

```bash
sync1 status --root <local-path> [--filter <glob>] [--json]
```

## Options

| Flag              | Required | Description                                                                                          |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `--root <path>`   | yes      | Local directory whose vault to inspect.                                                              |
| `--filter <glob>` | no       | SQLite `GLOB` pattern scoping which tracked paths' objects are considered (default `*`, everything). |

No password needed — `HEAD` requests don't decrypt anything, and policies are read from the
already-locally-decrypted `state.db`.

## What it does

For every distinct object (hash) with at least one path matching `--filter`:

1. Gathers **every** path referencing that hash (not just the ones matching `--filter` — a shared,
   deduped object's target has to account for every reference regardless of scope).
2. Evaluates each of those paths' target class against the current `storage_policy` rules, then reduces
   them to one target via **warmest wins**: never archives a shared object colder than any path that
   implies it should stay warm. When the paths disagreed, that's reported as a conflict alongside the
   counts — see [ignore-and-storage-policies.md](../architecture/ignore-and-storage-policies.md).
3. `HEAD`s the object's actual current storage class and archive/restore status, and buckets the
   comparison into one of five categories: already correct, needs an immediate copy (colder target),
   needs a restore request issued, a restore already in progress, or a restore that's ready to finalize
   with a copy.

## Output

```json
{
  "ok": true,
  "already_correct": 12,
  "changed_immediate": 1,
  "restore_requested": 0,
  "restore_pending": 0,
  "finalized": 0,
  "conflicts": [
    { "hash": "...", "paths": ["cold-copy.txt", "warm-copy.txt"], "target_class": "STANDARD" }
  ]
}
```

## Exit codes

- `0` — success (regardless of counts — this is a report, not a validator; a conflict doesn't fail it).
- `1` — the root isn't initialized/attached, or a filesystem/S3 error (including a corrupt vault: an
  entry referencing an object with no `objects` row, or an object missing from S3 entirely).

## Example

```bash
sync1 status --root ~/Pictures --json
sync1 status --root ~/Pictures --filter "2020/*" --json
```
