# `sync1 converge`

Applies `storage_policy`: moves each tracked object's actual S3 storage class to match what the
policies imply. Shares the exact same iteration/evaluation as [`status`](status.md) — `status` counts,
`converge` actually performs each transition (a self-copy for a colder target, `RestoreObject` for a
warmer one). No password needed — changing storage-class metadata or requesting a restore never reads
or writes encrypted object content.

## Usage

```bash
sync1 converge [--root <local-path>] [--filter <glob>] [--json] [--s3-metadata-parallelism <n>]
```

## Options

| Flag                            | Required | Description                                                                                                                                                                     |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--root <path>`                 | no       | Local directory whose vault to operate on. Defaults to the nearest ancestor directory with a `.sync1/` (like git's `.git/` lookup), searched upward from the current directory. |
| `--filter <glob>`               | no       | [Glob pattern](../README.md#glob-syntax) scoping which tracked paths' objects are converged (default `*`).                                                                      |
| `--s3-metadata-parallelism <n>` | no       | Max concurrent `HEAD`/copy/restore calls, one dispatched per distinct hash. Default 8.                                                                                          |

See [concurrency-and-progress.md](../architecture/concurrency-and-progress.md) for how each hash's
`HEAD` + classify + conditional copy/restore dispatches as one unit of work.

## What it does

Identical evaluation to `status` (see [status.md](status.md) for the full walk-through: per-path target
evaluation, warmest-wins reduction across a shared object's referencing paths, `HEAD` + archive-status
classification) — but for each decided action, actually issues it:

- **Needs an immediate copy** (colder target) → a self-copy changing only the storage class.
- **Needs a restore request** → `RestoreObject` (a fixed 7-day, Standard-tier restore window).
- **Restore ongoing** → nothing to do yet, just counted.
- **Ready to finalize** → the same self-copy, now that the temporary restored copy is available.
- **Already correct** → nothing to do.

A dedup warmest-wins conflict (two paths sharing an object but implying different classes) is still
converged to the warmest of the disagreeing targets — an object is never archived colder than any path
that wants it kept warm — and the disagreement is still reported alongside the counts, exactly like
`status`.

## Output

Same shape as [`status`](status.md)'s output.

## Exit codes

- `0` — success (regardless of counts).
- `1` — the root isn't initialized/attached, or a filesystem/S3 error (including a corrupt vault).

## Example

```bash
sync1 converge --root ~/Pictures --json
sync1 converge --root ~/Pictures --filter "2020/*" --json
```
