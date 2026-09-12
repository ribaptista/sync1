# `sync1 sanity_check`

A **read-only diagnostic**, purely for finding bugs. It never repairs anything — no auto-cleanup of
dangling stubs, no re-hashing to "fix" a mismatch, no deletion of untracked files. It cross-checks
`state.db` against both S3 (does the referenced object still actually exist) and the local filesystem
(does the real/stub content still match what's recorded), and separately finds local files that exist on
disk but aren't tracked and don't match any ignore policy. No password is needed — `HEAD` requests and
rehashing local plaintext both need no decryption. See
[ignore-and-storage-policies.md](../architecture/ignore-and-storage-policies.md) for how ignore-policy
matching fits in.

## Usage

```bash
sync1 sanity_check --root <local-path> [--filter <glob>] [--json]
```

## Options

| Flag              | Required | Description                                                               |
| ----------------- | -------- | ------------------------------------------------------------------------- |
| `--root <path>`   | yes      | Local directory to check. Must already be initialized or attached.        |
| `--filter <glob>` | no       | SQLite `GLOB` pattern scoping which tracked/untracked paths are reported. |

## What it checks

For every path that's either tracked in `state.db`, present locally, or both:

- **Both a stub and the real file present** for the same path → always reported as a bad state
  (`both_stub_and_real`), never auto-cleaned the way `update_cache`/`materialize` normally would — this is
  exactly the kind of state that's normally silently self-healed elsewhere, so it's worth surfacing here.
- **Real file present** → rehashed and compared against `state.db`'s recorded hash; a mismatch is
  `hash_mismatch`.
- **Stub present** → its self-declared hash is read and validated; a malformed stub or one that disagrees
  with `state.db`'s recorded hash is `stub_mismatch`.
- **Every tracked file**, regardless of local representation, also gets an S3 existence check (`HEAD`) on
  the object its hash refers to — missing → `missing_in_s3`.
- **Tracked in state.db, but no local presence at all** (neither a stub nor a real file) →
  `missing_locally`.
- **Present locally, not tracked** → checked against ignore policies; a match is silently excluded (just
  counted, via `ignored_count`), since it isn't a problem — an untracked path that isn't ignored is
  `untracked`.

Directories are only checked for presence on both sides — there's no content to hash or an S3 object to
check.

`--filter` scopes which paths are actually _reported_ (and, for tracked paths, which incur the cost of a
rehash/HEAD check) — the underlying walk and `state.db` scan always cover the whole tree, since a partial
comparison can't reliably tell "filtered out" apart from "genuinely missing" on either side.

## Output

```json
{
  "ok": false,
  "both_stub_and_real": ["dual.txt"],
  "hash_mismatch": [{ "path": "tampered.txt", "expected_hash": "...", "actual_hash": "..." }],
  "stub_mismatch": [{ "path": "img.jpg", "reason": "malformed stub content: \"...\"" }],
  "missing_in_s3": [{ "path": "vanishing.txt", "hash": "..." }],
  "missing_locally": ["ghost.txt"],
  "untracked": ["stray.txt"],
  "ignored_count": 1
}
```

## Exit codes

- `0` — every bucket above (except `ignored_count`, which is never a problem) is empty.
- `1` — at least one problem was found, or a filesystem/S3 error.

## Example

```bash
sync1 sanity_check --root ~/Pictures --json
sync1 sanity_check --root ~/Pictures --filter "2024/*" --json
```
