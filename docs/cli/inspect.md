# `sync1 inspect`

A read-only JSON query tool over `cache.db` and `state.db` for a path or glob pattern. Unlike most
commands here, `inspect` is aimed as much at **other tools built on top of a vault** as it is at
interactive use — for example, the thumbnail-generation utility discussed during this project's design
(a separate tool that would decide whether a thumbnail is stale by comparing a marker file's recorded
hash against the current hash `inspect` reports, and by comparing `sequence` numbers to establish
ordering without depending on wall-clock timestamps, which are vulnerable to clock skew across
machines). No password is needed — it never decrypts content, only reads already-local metadata.

## Usage

```bash
sync1 inspect <path-or-glob> [--root <local-path>] [--json]
```

`--root` defaults to the nearest ancestor directory containing a `.sync1/` (searched from the current
directory upward) when omitted.

## Arguments

| Argument         | Description                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `<path-or-glob>` | An exact tracked path, or a [glob pattern](../README.md#glob-syntax) (detected by the presence of `*`, `?`, or `[`). |

## Exact path vs. glob pattern

These behave differently on purpose:

- **Exact path** (no glob characters): always returns exactly one result, even if the path isn't
  tracked anywhere — `cache`/`state` are simply `null`. This is what lets a caller distinguish "never
  synced" from "synced but not locally tracked" instead of getting nothing back.
- **Glob pattern**: returns one line per actual match (zero or more) from either `cache.db` or
  `state.db` — no result is invented for a pattern that matches nothing.

## Output

One JSON object per line (JSONL), even for a single exact-path query:

```json
{
  "path": "photos/2024/img0001.jpg",
  "cache": { "hash": "...", "mtime": 1735689600000, "state": "unchanged" },
  "state": {
    "hash": "...",
    "state_version": "20260101T020000000Z-a1b2c3d4",
    "sequence": 42,
    "size": 4213311
  }
}
```

`cache`/`state` are independently `null` when the path isn't tracked on that side. `sequence` is the
`versions` table's append-only ordering, safe to compare across machines regardless of clock skew (see
[dedup-and-object-storage.md](../architecture/dedup-and-object-storage.md) and the design notes on the
`versions` table). Crypto internals (`s3_key`, wrapped keys, nonces) are never included — nothing
downstream needs them, and there's no reason to hand that detail to arbitrary tools.

## Exit codes

- `0` — success (regardless of how many/few results were found).
- `1` — the root isn't initialized/attached, or a filesystem/database error.

## Example

```bash
sync1 inspect "photos/2024/*" --root ~/Pictures --json
```
