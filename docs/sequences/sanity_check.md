# `sync1 sanity_check`

**Derived from:** `src/commands/sanity_check.ts`, `src/fs/sanity-check.ts`, `src/fs/encrypt-file.ts`,
`src/concurrency/hash-worker.ts`, `src/concurrency/hash-runner.ts`

Read-only diagnostic: cross-checks `state.db` against S3 and the local filesystem for bugs, **never
repairs anything**. Structurally the same streaming merge-join as `update_cache`, but where that command
silently repairs what it finds, this one only reports — surfacing exactly the class of problem
`update_cache`/`materialize` would otherwise fix without a trace, or never notice at all (a corrupt
stub, a tampered file, an entry whose object vanished from S3 or whose checksum drifted, an untracked
file). Unlocks the vault first ([`flow-unlock-vault.md`](flow-unlock-vault.md)) — nothing is ever
decrypted, but re-encrypting a local file for its ciphertext checksum needs the master key; `state.db` is
opened read-only. Runs after the ordinary lock/root-resolution preamble (see
[`flow-preamble.md`](flow-preamble.md)), omitted below since it never varies.

## Sequence — the merge-join

```mermaid
sequenceDiagram
    participant Loop as merge-join loop
    participant FS
    participant State as state.db (read-only)
    participant Stream as stream pool
    participant S3Pool as s3 pool
    participant S3

    Loop->>Loop: start enumerateSanityCheckWork -- NOT awaited, see flow-enumeration-pass.md

    loop while either cursor has rows left
        alt fs-only path
            alt in --filter scope
                Loop->>Loop: matches an ignore policy? -> ignoredCount++ : untracked.push(path)
            end
        else entry-only path (tracked, missing from disk)
            opt in --filter scope
                Loop->>Loop: missingLocally.push(path)
            end
        else path in both
            alt out of --filter scope
                Loop->>Loop: still discovered/resolved, never checked
            else
                Loop->>Loop: dispatchTrackedEntryCheck(...) -- see below
            end
        end
    end

    Loop->>Stream: await streamPool.onIdle() -- MUST come first: a read job's own completion<br/>is what enqueues its follow-on HEAD check
    Loop->>S3Pool: await s3Pool.onIdle(); throwIfPoolErrored() (both pools)
    Loop->>Loop: sort hashMismatch, missingInS3, checksumMismatch by path (dispatch order isn't path order)
    Loop->>FS: stat every stale in-tree temp file the walk collected -- report size, never remove
```

## Sequence — `dispatchTrackedEntryCheck`

```mermaid
sequenceDiagram
    participant Job as dispatchTrackedEntryCheck
    participant FS
    participant Stream as stream pool
    participant S3Pool as s3 pool
    participant S3

    alt entry.type = "dir"
        Job->>Job: nothing further -- existence alone was already confirmed
    else both a stub AND the real file present
        Job->>Job: bothStubAndReal.push(path) -- a bad state, never auto-cleaned here
    else entry.hash is null
        Job--xJob: throw -- state.db is corrupt (migration 0013's CHECK makes<br/>this unreachable for a real entries row; a defensive invariant, not a live path)
    else representation = "real"
        Job->>Stream: streamPool.dispatch(readLocal) -- one read: BLAKE2b + re-encrypt + CRC64NVME
        alt plaintextHash != entry.hash
            Stream-->>Job: hashMismatch.push({path, expectedHash, actualHash}) -- stops here, no HEAD
        else
            Stream-->>Job: dispatchS3Check(entry.hash, localChecksum) -- see below
        end
    else representation = "stub"
        Job->>FS: readStubHash(stubPath) -- cheap, synchronous, no pool
        alt corrupt stub (StubFormatError)
            Job->>Job: stubMismatch.push({path, reason}) -- stops here, no HEAD
        else stubHash != entry.hash
            Job->>Job: stubMismatch.push({path, reason: "stub declares X, state.db expects Y"}) -- stops here, no HEAD
        else
            Job->>S3Pool: dispatchS3Check(entry.hash, null) -- no local plaintext to compare
        end
    end
```

`dispatchS3Check(hash, localChecksum)`: `objectsRepo.get(hash)` missing → `missingInS3.push({path,
hash})` immediately; otherwise dispatched to `s3Pool` → `headObject(s3_key)` (`ChecksumMode: "ENABLED"`)
→ not found → `missingInS3.push`; found → compare `objectRow.ciphertext_checksum` (recorded),
`head.checksumCrc64Nvme ?? null` (S3's), and `localChecksum` (null for a stub) — any disagreement, or a
null S3 checksum, → `checksumMismatch.push({path, hash, localChecksum, recordedChecksum, s3Checksum})`.

### `readLocal` (production: `createChecksumRunner`, dispatched to a hash-pool worker thread)

The one place a real file is actually read, and the only step `sanity_check` spends real CPU on: inside
the worker thread, `fs.createReadStream` → `encryptStream(..., { hashMismatch: "report" })`, which hashes
the plaintext (BLAKE2b) as it re-encrypts it the same pass → a `UploadChecksumTap` over the ciphertext
(CRC64NVME) → drained to nothing. `"report"` never aborts the stream on a hash disagreement the way
sync's own upload does (see [`flow-encrypt-stream.md`](flow-encrypt-stream.md)) — the point here is to
learn the _actual_ hash of whatever is on disk and let the caller (this module) decide, not to guard a
write. This is the single pass that makes `hash_mismatch` and `checksum_mismatch` both derive from one
read instead of two.

**Why a worker thread.** Measured on one core: BLAKE2b ~1090 MiB/s, XChaCha20 ~1170 MiB/s, but the pure-JS
CRC64NVME is only ~240 MiB/s and dominates the pass's CPU time (confirmed directly, not assumed). Each
file's read is independent, so `src/commands/sanity_check.ts` binds `readLocal` to
`createChecksumRunner(pools.hash, masterKey)` (`src/concurrency/hash-runner.ts`) rather than running it on
the main thread — the exact same multi-core reasoning `update_cache`'s own file hashing already uses (see
`src/concurrency/hash-worker.ts`'s own top-of-file comment). The worker side is `checksumFileTask`
(`hash-worker.ts`), dispatched by _name_ (`pool.run(task, { name: "checksumFileTask" })`) since the same
worker file's **default** export, `hashFileTask`, is what `update_cache`/`stubify` still use for a plain
hash with no encryption. `--hash-parallelism` (not `--file-stream-parallelism`) is therefore what bounds
`streamPool` here, sized in the command to `pools.hash.maxThreads` — the log label stays `"stream"` purely
because `src/fs/sanity-check.ts` itself is unchanged; it has no idea what kind of pool its `readLocal`
argument happens to be backed by.

## Output

```json
{
  "ok": true,
  "both_stub_and_real": [],
  "hash_mismatch": [],
  "stub_mismatch": [],
  "missing_in_s3": [],
  "checksum_mismatch": [],
  "missing_locally": [],
  "untracked": ["scratch.txt"],
  "ignored_count": 2,
  "stale_temp_files": []
}
```

`ok` is `false` whenever the total problem count (every category except `ignored_count`) is non-zero.

## Notes

- **Concurrency, and a load-bearing drain order.** The stream pool and the s3 pool are two independently
  bounded pools (see [`flow-pool-dispatch.md`](flow-pool-dispatch.md)), but they are not drained
  independently: `streamPool.onIdle()` **must** be awaited before `s3Pool.onIdle()`, because a read job's
  own completion is what enqueues its follow-on HEAD check — draining `s3Pool` first could miss checks a
  still-running read job hadn't enqueued yet.
- **A stub's declared hash never touches the stream pool at all** — `readStubHash` is a cheap synchronous
  read, unlike re-encrypting a real file's actual bytes, so that branch dispatches straight to
  `dispatchS3Check` with no stream job in between, and its row always has `localChecksum: null`.
- **Every pool-reported bucket is explicitly re-sorted by path before returning** — dispatch order is not
  completion order once work is spread across two pools, so the merge-join's own path ordering would
  otherwise be lost by the time results are collected.
- **`--filter` scopes reporting and cost, never the walk itself.** The merge-join always walks the whole
  tree and the whole `entries` table regardless of `--filter` — a partial merge-join couldn't tell
  "filtered out" apart from "genuinely missing" on either side. Only whether an in-both-sides path
  actually gets read/HEAD-checked (and whether an fs-only/entry-only path gets reported at all) is
  gated by `--filter`.
- **Stale in-tree temp files are reported, never removed** — this command is read-only by design, and
  nothing else will ever clean these up either: the startup lock-hook sweep only reads `.sync1/`, and
  every ordinary walk excludes temp names by construction, so they are otherwise invisible dead space
  (a partially-decrypted `materialize` temp can be many GB).
- **On failure:** a pool error from either pool (a real read/encryption failure, a genuine S3 error
  rather than "object not found") is captured via `dispatchTracked`/`throwIfPoolErrored` and fails the
  whole command; anything actually _found wrong_ is reported in the result, not thrown.
- **Sub-flows:** [`flow-unlock-vault.md`](flow-unlock-vault.md), [`flow-pool-dispatch.md`](flow-pool-dispatch.md),
  [`flow-enumeration-pass.md`](flow-enumeration-pass.md), [`flow-encrypt-stream.md`](flow-encrypt-stream.md).
