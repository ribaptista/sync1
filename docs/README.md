# sync1 documentation

## CLI commands

| Command                                               | Description                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`init_remote`](cli/init_remote.md)                   | Create a brand-new vault in S3 for a local root directory.                      |
| [`attach_remote`](cli/attach_remote.md)               | Attach a local root to an existing vault (join from a new machine, or restore). |
| [`update_cache`](cli/update_cache.md)                 | Rescan the local root and refresh `cache.db` to match what's on disk.           |
| [`sync`](cli/sync.md)                                 | Reconcile local changes with the remote vault, in both directions.              |
| [`fetch_remote`](cli/fetch_remote.md)                 | Pull the latest state.db snapshot without touching the filesystem or cache.db.  |
| [`ensure_storage_class`](cli/ensure_storage_class.md) | Move objects matching a glob to a target S3 storage class (archive/restore).    |
| [`materialize`](cli/materialize.md)                   | Download and materialize stub files matching a glob into real content.          |
| [`stubify`](cli/stubify.md)                           | Replace real files matching a glob with stubs, freeing local disk space.        |
| [`inspect`](cli/inspect.md)                           | Read-only JSON query over cache.db/state.db for a path or glob, for tooling.    |
| [`gc`](cli/gc.md)                                     | Remove S3 objects no longer referenced by the vault's current live state.       |

## Architecture

| Doc                                                                                           | Covers                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [vault-and-encryption.md](architecture/vault-and-encryption.md)                               | `vault.json`, KDF choice, the chunked AEAD codec, convergent vs. random-context encryption, the CAS mechanism.                                                                       |
| [cache-and-filesystem-scanning.md](architecture/cache-and-filesystem-scanning.md)             | Why cache.db is unencrypted; the sorted merge-join walker.                                                                                                                           |
| [dedup-and-object-storage.md](architecture/dedup-and-object-storage.md)                       | The `objects` table, content-addressing, upload-before-reference ordering.                                                                                                           |
| [conflict-resolution.md](architecture/conflict-resolution.md)                                 | The full create/modified/deleted conflict matrix, leniency rules, why cache.db is diffed directly against the candidate rather than compared by version stamp, CAS-failure handling. |
| [storage-classes-and-archive-restore.md](architecture/storage-classes-and-archive-restore.md) | The three supported storage classes, the shared HEAD-status classification primitive, limits of testing archive timing against LocalStack.                                           |
| [stub-files.md](architecture/stub-files.md)                                                   | The self-describing stub format, the four-state representation logic, crash-safety ordering in materialize/stubify.                                                                  |
| [garbage-collection-scope.md](architecture/garbage-collection-scope.md)                       | Why `gc` is scoped to current-state-only, and the CAS-retry test seam.                                                                                                               |
| [cross-platform-filesystem.md](architecture/cross-platform-filesystem.md)                     | Case-insensitive-filesystem collision detection (Windows/macOS), the two checkpoints and why others were dropped, recovery guidance, known limitations.                              |

## Conventions across all commands

- **`--json`**: every command supports a global `--json` flag for machine-readable output. On success, output is a single JSON object (or JSONL for glob/batch results like `inspect`) with `ok: true` plus command-specific fields. On failure, `{ ok: false, error: "<message>" }`.
- **`--verbose`**: raises logging to debug level (structured, stderr-only via `pino`, never stdout) — safe to combine with `--json` since logs never share a stream with result output.
- **Exit codes**: `0` success, `1` generic error, `2` unresolved sync conflict, `3` data corruption (a malformed/unverifiable stub, a missing or undecryptable S3 object, a vault or snapshot that fails to parse). See [conflict-resolution.md](architecture/conflict-resolution.md) for what triggers `2` and each architecture doc above for what triggers `3` in that area.
- **Password scope**: only commands that read or write encrypted content (state.db snapshots or content objects) prompt for the vault password — `init_remote`, `attach_remote`, `fetch_remote`, `sync`, `gc`, and `materialize`. `update_cache`, `inspect`, `stubify`, and `ensure_storage_class` never need it: `update_cache` and `inspect` only ever touch the unencrypted `cache.db`, `stubify` only ever removes local files it already has and writes a stub containing a hash already recorded locally, and `ensure_storage_class` only changes S3 storage-class metadata without reading or writing object content.
