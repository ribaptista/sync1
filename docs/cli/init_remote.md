# `sync1 init_remote`

Creates a brand-new backup vault in S3 for a local root directory. Run this once per vault, on the
first machine. To back up an _additional_ machine to a vault that already exists, use `attach_remote`
instead (not yet implemented) — `init_remote` refuses to run against a non-empty S3 location.

## Usage

```bash
sync1 init_remote --bucket <bucket> --root <local-path> [options]
```

## Options

| Flag                | Required | Description                                                                           |
| ------------------- | -------- | ------------------------------------------------------------------------------------- |
| `--bucket <bucket>` | yes      | S3 bucket name.                                                                       |
| `--root <path>`     | yes      | Local directory to back up. Must not already contain a `.sync1/` directory.           |
| `--prefix <prefix>` | no       | S3 key prefix within the bucket (default: none — the vault lives at the bucket root). |
| `--endpoint <url>`  | no       | S3-compatible endpoint, e.g. a LocalStack URL. Omit to use real AWS S3.               |
| `--region <region>` | no       | AWS region (default: `us-east-1`).                                                    |

Global flags `--json` and `--verbose` also apply (see the top-level `sync1 --help`).

## Password

The vault password is never accepted as a plain CLI argument (it would leak into shell history and be
visible to other processes via `ps`). It's resolved as:

1. The `SYNC1_PASSWORD` environment variable, if set (used for automation/scripting).
2. Otherwise, an interactive masked prompt.

## What it does

1. Checks `<root>/.sync1` doesn't already exist.
2. Checks the S3 location (`bucket`/`prefix`) is empty.
3. Derives the vault's master key from the password (Argon2id) and generates a fresh KDF salt.
4. Creates an empty state.db with one initial version.
5. Uploads, in order: `vault.json` (the vault manifest), the encrypted initial state.db snapshot at
   `states/<version_stamp>`, and the `current` pointer — each with a conditional write
   (`If-None-Match: *`) so a race against another `init_remote` targeting the same location fails
   loudly rather than silently overwriting.
6. Writes the local `.sync1/` directory: `state.db`, `vault.json` (a cached copy), and
   `last_synced_version`.

## Output

On success (`--json`):

```json
{
  "ok": true,
  "version_stamp": "20260101T020000000Z-a1b2c3d4",
  "bucket": "my-bucket",
  "prefix": "myvault",
  "root": "/abs/path"
}
```

On failure (`--json`):

```json
{ "ok": false, "error": "..." }
```

## Exit codes

- `0` — success.
- `1` — any failure (root already initialized, S3 location not empty, S3/network error).

## Example

```bash
SYNC1_PASSWORD='correct horse battery staple' \
  sync1 init_remote --bucket my-backups --prefix photos-vault --root ~/Pictures --json
```
