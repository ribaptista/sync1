# `sync1 gc`

Removes S3 objects no longer referenced by any path in the vault's current live state — for reclaiming
storage after deleting files. Scoped to the **current** state only; see
[garbage-collection-scope.md](../architecture/garbage-collection-scope.md) for the tradeoff this
implies for old, retained `/states/<version>` snapshots.

## Usage

```bash
sync1 gc [--root <local-path>] [--apply] [--json] [--verbose] [--s3-metadata-parallelism <n>]
```

## Options

| Flag                            | Required | Description                                                                                                                                       |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--root <path>`                 | no       | Local directory whose vault to clean up. Defaults to the nearest ancestor directory with a `.sync1/`, searched from the current directory upward. |
| `--apply`                       | no       | Actually delete orphaned objects. Without it, only counts what _would_ be removed.                                                                |
| `--s3-metadata-parallelism <n>` | no       | With `--apply`, max concurrent `DeleteObject` calls. Default 8.                                                                                   |

The vault password is required (gc reads and re-encrypts state.db).

## What it does

1. Always fetches `/current` fresh from S3 (never trusts local state.db, which may be stale).
2. Computes every content hash still referenced by a live entry, and diffs that against the `objects`
   table to find orphans.
3. In count-only mode (the default), just reports the numbers.
4. With `--apply`: removes the orphaned rows from a candidate copy of state.db, commits it via the same
   CAS-guarded `/current` write `sync` uses, and only **after** that commit succeeds does it delete the
   actual S3 object bytes (dispatched concurrently, see
   [concurrency-and-progress.md](../architecture/concurrency-and-progress.md)) — this ordering means a
   crash between committing the metadata change and deleting the bytes just leaves harmless orphaned
   bytes for the next `gc` run to catch, never a dangling reference to bytes that no longer exist.
5. If another commit lands between gc's read of `/current` and its own CAS attempt, gc automatically
   refetches and recomputes rather than failing — unlike `sync`'s conflicts, removing orphans is a pure
   recomputation with no human judgment involved, so retrying on its own is safe. (Bounded to 5 attempts
   before giving up with an error, as a safety net against a pathological run of concurrent commits.)

## Dedup interaction

An object is only orphaned once **no** path references its hash — deleting one of several paths that
share identical content leaves the object intact for the others.

## Output

```json
{ "ok": true, "applied": true, "orphan_count": 3, "reclaimed_bytes": 15728640 }
```

## Exit codes

- `0` — success.
- `1` — wrong password, corrupt vault, too many concurrent commits to resolve, or an S3/network error.

## Example

```bash
# see what would be reclaimed
SYNC1_PASSWORD='correct horse battery staple' sync1 gc --root ~/Pictures --json

# actually reclaim it
sync1 gc --root ~/Pictures --apply --json
```
