# `sync1 diff`

Lists the local changes a `sync` would commit — every path `update_cache` recorded as `created`,
`modified` or `deleted`, plus a count of each.

**It reports what `update_cache` last recorded, not a fresh scan.** Unlike `git status`, this never walks
the tree: `update_cache` already computed the comparison and stored it in cache.db's `state` column, and
this reads that column back. So the answer is exactly as current as your last `update_cache`, and stale
if the tree has changed since.

The cheapest command in the tool. It reads **cache.db alone**, read-only — no state.db, no S3 client, no
password, no network. A whole-vault report on 33,000 paths takes well under a second.

## Usage

```bash
sync1 diff [--root <local-path>] [--glob <pattern>] [--json]
```

## Options

| Flag               | Required | Description                                                                                                                      |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--root <path>`    | no       | Local directory to report on. Must already be initialized/attached. Defaults to the nearest ancestor directory with a `.sync1/`. |
| `--glob <pattern>` | no       | [Glob pattern](../README.md#glob-syntax) scoping which paths are reported. Filters the listing and the counts together.          |

## Output

```
deleted   photos/gone.jpg
created   photos/new.jpg
modified  photos/edited.jpg
diff: 1 created, 1 modified, 1 deleted (3 pending)
```

Deletions come first, then everything else, each group sorted by path — that is the order `sync` itself
applies them in, reused rather than re-sorted so the report can stream instead of buffering the whole
change set.

With `--json`, output is JSONL (the same shape `inspect` uses): one object per change, then a summary
object last.

```json
{"path":"photos/new.jpg","state":"created","type":"file","hash":"…","size":1234,"parent_state_version":null}
{"ok":true,"created":1,"modified":1,"deleted":1,"total":3}
```

Per-path detail is streamed as it is read, so neither mode holds the change set in memory — which matters
on a first sync, where every path in the vault is `created`.

## Exit codes

- `0` — the report was produced, **including when changes are pending**. This is a report, not a check.
- `1` — the root isn't initialized/attached, or `update_cache` has never run there (there is no cache.db
  to read, and answering "0 changes" would say "nothing changed" when the truth is "nothing was looked
  at").

## Example

```bash
sync1 update_cache --root ~/Pictures --json    # refresh what diff reads
sync1 diff --root ~/Pictures
sync1 diff --root ~/Pictures --glob "2024/**" --json
```
