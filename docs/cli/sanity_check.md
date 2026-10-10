# `sync1 sanity_check`

A **read-only diagnostic**, purely for finding bugs. It never repairs anything — no auto-cleanup of
dangling stubs, no re-hashing to "fix" a mismatch, no deletion of untracked files. It cross-checks
`state.db` against both S3 (does the referenced object still exist, and does its checksum still match
what was recorded at upload) and the local filesystem (does the real/stub content still match what's
recorded, and does a real file still re-encrypt to exactly the stored object), and separately finds local
files that exist on disk but aren't tracked and don't match any ignore policy. See
[ignore-and-storage-policies.md](../architecture/ignore-and-storage-policies.md) for how ignore-policy
matching fits in.

**Needs the vault password** (`SYNC1_PASSWORD`, or an interactive prompt) — nothing is ever decrypted, but
re-encrypting a local file to compare its ciphertext checksum needs the master key (encryption is
convergent: same key, same content, same bytes every time — see
[vault-and-encryption.md](../architecture/vault-and-encryption.md)). A wrong password fails before
anything is checked.

> Full sequence-diagram trace: [sanity_check.md](../sequences/sanity_check.md).

## Usage

```bash
sync1 sanity_check [--root <local-path>] [--filter <glob>] [--json] [--hash-parallelism <n>] [--s3-metadata-parallelism <n>]
```

## Options

| Flag                            | Required | Description                                                                                                                                                                 |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--root <path>`                 | no       | Local directory to check. Must already be initialized or attached. Defaults to the nearest ancestor directory with a `.sync1/`, searched from the current directory upward. |
| `--filter <glob>`               | no       | [Glob pattern](../README.md#glob-syntax) scoping which tracked/untracked paths are reported.                                                                                |
| `--hash-parallelism <n>`        | no       | Max concurrent read-and-re-encrypt jobs for real files, run on real worker threads. Default: CPU count.                                                                     |
| `--s3-metadata-parallelism <n>` | no       | Max concurrent `HEAD` checks (existence and checksum). Default 8.                                                                                                           |

A real file is read exactly once: the same pass that computes its BLAKE2b content hash also encrypts it
(convergent encryption, so this reproduces the exact bytes an upload would have produced) and checksums
the result, dispatched to `--hash-parallelism`'s worker-thread pool — the CRC64NVME step in particular is
pure-JS and CPU-bound, so spreading different files' reads across real cores is a genuine speed-up, not
just overlapped I/O. `HEAD` checks run on their own, separately-bounded pool (see
[concurrency-and-progress.md](../architecture/concurrency-and-progress.md)) — a file only gets one once
its hash is confirmed to still match.

`--file-stream-parallelism` is still a global flag, but `sanity_check` never uses it: there's no separate
I/O-bound streaming pass here, unlike `sync`/`materialize`. Use `--hash-parallelism 1` on a spinning disk,
where reading several files at once costs more in seeking than it gains from extra cores;
`--hash-parallelism`'s default (CPU count) favors an SSD or NVMe, where it scales close to linearly.

## What it checks

For every path that's either tracked in `state.db`, present locally, or both:

- **Both a stub and the real file present** for the same path → always reported as a bad state
  (`both_stub_and_real`), never auto-cleaned the way `update_cache`/`materialize` normally would — this is
  exactly the kind of state that's normally silently self-healed elsewhere, so it's worth surfacing here.
- **Real file present** → read once, producing both its actual BLAKE2b hash and (re-encrypting it the
  same pass) the CRC64NVME its ciphertext would have. The hash is compared against `state.db`'s recorded
  one first; a mismatch is `hash_mismatch`, and nothing further is checked for that file — there's no
  object to meaningfully compare a changed file's ciphertext against.
- **Stub present** → its self-declared hash is read and validated; a malformed stub or one that disagrees
  with `state.db`'s recorded hash is `stub_mismatch`. A stub has no local plaintext, so there's nothing to
  re-encrypt.
- **Every tracked file whose hash matches** (real or stub), regardless of local representation, gets an
  S3 check (`HEAD`, with checksums enabled) on the object its hash refers to — missing → `missing_in_s3`.
  Present, but the CRC64NVME any of the three sides disagree on (the local re-encrypt, `state.db`'s
  recorded value, or what S3 reports — null counts as disagreeing) → `checksum_mismatch`. A stub's row
  always has a null `local_checksum`, since there's no local plaintext to compare.
- **Tracked in state.db, but no local presence at all** (neither a stub nor a real file) →
  `missing_locally`.
- **Present locally, not tracked** → checked against ignore policies; a match is silently excluded (just
  counted, via `ignored_count`), since it isn't a problem — an untracked path that isn't ignored is
  `untracked`.
- **An in-tree staging file** (`.sync1-tmp-…`, written next to its destination and renamed into place) →
  `stale_temp_files`. One only exists if a run died between the write and the rename, since Ctrl+C is a
  `process.exit()` that skips the cleanup. Nothing else ever reports or removes them: the startup sweep
  reads only `.sync1/`, and every walk excludes them by name — so they are invisible dead space, and a
  partially-downloaded `materialize` temp can be many GB. Reported with sizes, never deleted; this
  command is read-only, so removal is yours to do once no sync1 command is running.

Directories are only checked for presence on both sides — there's no content to hash or an S3 object to
check.

`--filter` scopes which paths are actually _reported_ (and, for tracked paths, which incur the cost of a
read/HEAD check) — the underlying walk and `state.db` scan always cover the whole tree, since a partial
comparison can't reliably tell "filtered out" apart from "genuinely missing" on either side.

## Output

```json
{
  "ok": false,
  "both_stub_and_real": ["dual.txt"],
  "hash_mismatch": [{ "path": "tampered.txt", "expected_hash": "...", "actual_hash": "..." }],
  "stub_mismatch": [{ "path": "img.jpg", "reason": "malformed stub content: \"...\"" }],
  "missing_in_s3": [{ "path": "vanishing.txt", "hash": "..." }],
  "checksum_mismatch": [
    {
      "path": "corrupted.txt",
      "hash": "...",
      "local_checksum": "...",
      "recorded_checksum": "...",
      "s3_checksum": "..."
    }
  ],
  "missing_locally": ["ghost.txt"],
  "untracked": ["stray.txt"],
  "ignored_count": 1,
  "stale_temp_files": [{ "path": "photos/.sync1-tmp-f0e1d2c3...", "size": 41231872 }]
}
```

## Exit codes

- `0` — every bucket above (except `ignored_count`, which is never a problem) is empty.
- `1` — at least one problem was found, or a filesystem/S3 error.

All-or-nothing: a file modified (or deleted) while the check is reading it, or any other per-file read
error, aborts the whole run rather than reporting a partial result — there is no `--json` output and no
exit code specific to "something changed mid-run." Re-run once the vault is quiescent.

## Example

```bash
sync1 sanity_check --root ~/Pictures --json
sync1 sanity_check --root ~/Pictures --filter "2024/*" --json
```
