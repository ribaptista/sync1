# `sync1 attach_remote`

Attaches a local root directory to an **existing** vault — how a second (or third, ...) machine joins
a backup already created with `init_remote`. This is also the entry point for "restoring" a backup
onto a new machine: after attaching, running `sync` materializes the tree (as stub files by default,
so nothing downloads until you ask for it via `materialize`).

## Usage

```bash
sync1 attach_remote --bucket <bucket> [--root <local-path>] [options]
```

## Options

Same shape as `init_remote`: `--bucket` (required), `--root` (optional, defaults to the current
directory — see [`init_remote`](init_remote.md#options)), `--prefix`, `--endpoint`, `--region`. See
[`init_remote`](init_remote.md) for details on each.

## Password

Same resolution order as every other command: `SYNC1_PASSWORD` env var, else an interactive masked
prompt. Never accepted as a plain CLI argument.

## What it does

1. Checks `<root>/.sync1` doesn't already exist.
2. Fetches `vault.json` and derives the master key from the password — the manifest's built-in
   verifier means a wrong password is rejected immediately, with a clear `incorrect password` error,
   **before anything is written to disk**.
3. Fetches the `/current` pointer and the state.db snapshot it names, decrypts it.
4. Writes the local `.sync1/` directory: the decrypted `state.db`, a cached `vault.json`, and
   `last_synced_version` — and creates an empty, freshly-migrated `cache.db`.

Unlike `sync`, this command makes **no changes to the root directory's actual files** — it only
touches `.sync1/`. That mirrors `fetch_remote`'s contract deliberately: fetching/attaching and
materializing content are separate concerns.

## Output

Same JSON shape as `init_remote`: `{ "ok": true, "version_stamp": "...", "bucket": "...", "prefix": "...", "root": "..." }`
on success, `{ "ok": false, "error": "..." }` on failure.

## Exit codes

- `0` — success.
- `1` — any failure (root already attached, no vault found at that location, wrong password, corrupt
  vault data).

## Example

```bash
SYNC1_PASSWORD='correct horse battery staple' \
  sync1 attach_remote --bucket my-backups --prefix photos-vault --root ~/Pictures --json
```
