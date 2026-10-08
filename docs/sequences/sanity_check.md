# `sync1 sanity_check`

**Derived from:** `src/commands/sanity_check.ts`, `src/fs/sanity-check.ts`,
`src/fs/ciphertext-checksum.ts`

Read-only diagnostic: cross-checks `state.db` against S3 and the local filesystem for bugs, **never
repairs anything**. Structurally the same streaming merge-join as `update_cache`, but where that command
silently repairs what it finds, this one only reports — surfacing exactly the class of problem
`update_cache`/`materialize` would otherwise fix without a trace, or never notice at all (a corrupt
stub, a tampered file, an entry whose object vanished from S3 or whose checksum drifted, an untracked
file). Unlocks the vault first ([`flow-unlock-vault.md`](flow-unlock-vault.md)) — nothing is decrypted,
but re-encrypting a local file for its ciphertext checksum needs the master key; `state.db` is opened
read-only. Runs after the ordinary lock/root-resolution preamble (see
[`flow-preamble.md`](flow-preamble.md)), omitted below since it never varies.

## Sequence — the merge-join

```mermaid
sequenceDiagram
    participant Loop as merge-join loop
    participant FS
    participant State as state.db (read-only)
    participant Hash as hash pool
    participant S3Pool as s3 pool
    participant StreamPool as stream pool
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

    Loop->>Hash: await hashJobs.onIdle() -- MUST come first: a hash job's own completion<br/>is what enqueues its follow-on S3 check
    Loop->>S3Pool: await s3Pool.onIdle() -- second: an S3 job's completion enqueues the re-encrypt
    Loop->>StreamPool: await streamPool.onIdle()
    Loop->>Loop: throwIfPoolErrored(s3), throwIfPoolErrored(stream)
    Loop->>Loop: sort hashMismatch, missingInS3, s3ChecksumMismatch, localChecksumMismatch by path
    Loop->>FS: stat every stale in-tree temp file the walk collected -- report size, never remove
```

## Sequence — `dispatchTrackedEntryCheck`

```mermaid
sequenceDiagram
    participant Job as dispatchTrackedEntryCheck
    participant FS
    participant Hash as hash pool
    participant S3Pool as s3 pool
    participant S3

    alt entry.type = "dir"
        Job->>Job: nothing further -- existence alone was already confirmed
    else both a stub AND the real file present
        Job->>Job: bothStubAndReal.push(path) -- a bad state, never auto-cleaned here
    else representation = "real"
        Job->>Hash: hashJobs.dispatch(rehash)
        alt actualHash != entry.hash
            Hash-->>Job: hashMismatch.push({path, expectedHash, actualHash})
        else entry.hash is set
            Hash-->>Job: dispatchS3Check(entry.hash, localPath) -- see below
        end
    else representation = "stub"
        Job->>FS: readStubHash(stubPath) -- cheap, synchronous, no pool
        alt corrupt stub (StubFormatError)
            Job->>Job: stubMismatch.push({path, reason})
        else stubHash != entry.hash
            Job->>Job: stubMismatch.push({path, reason: "stub declares X, state.db expects Y"})
        else entry.hash is set
            Job->>S3Pool: dispatchS3Check(entry.hash, null) -- see below; rowResolved() at dispatch
        end
    end
```

## Sequence — `dispatchS3Check` and `dispatchLocalChecksum`

```mermaid
sequenceDiagram
    participant Caller as hash job / stub branch
    participant State as state.db (read-only)
    participant S3Pool as s3 pool
    participant S3
    participant StreamPool as stream pool
    participant FS

    Caller->>State: objectsRepo.get(hash)
    alt no objects row
        Caller->>Caller: missingInS3.push({path, hash}); onSettled()
    else
        Caller->>S3Pool: await waitForRoom(s3Pool); dispatchTracked(...)
        S3Pool->>S3: headObject(s3_key) -- ChecksumMode ENABLED
        alt not found
            S3Pool->>S3Pool: missingInS3.push({path, hash})
        else found
            opt S3's CRC64NVME != objects.ciphertext_checksum (or S3 reports none)
                S3Pool->>S3Pool: s3ChecksumMismatch.push({path, hash, recordedChecksum, s3Checksum})
            end
            opt real file (localPath set) AND S3 reported a checksum
                S3Pool->>StreamPool: await waitForRoom(streamPool); expectBytes(size); dispatchTracked(...)
                StreamPool->>FS: localCiphertextChecksum -- read, encryptStream(expectedHash), CRC64NVME, discard
                alt codec/read error (file changed, size differs)
                    StreamPool->>StreamPool: localChecksumMismatch.push({..., localChecksum: null, reason})
                else checksum != S3's
                    StreamPool->>StreamPool: localChecksumMismatch.push({..., localChecksum, reason: null})
                end
                StreamPool->>StreamPool: onSettled()
            end
        end
        Note over S3Pool: onSettled() here unless handed off to the stream pool
    end
```

`onSettled` is the real-file row's `rowResolved()` (wrapped to fire once): a real file's row stays
unresolved until its last stage — hash on a mismatch, HEAD on a missing object or absent checksum,
otherwise the re-encrypt — since the re-encrypt is byte work too.

## Output

```json
{
  "ok": true,
  "both_stub_and_real": [],
  "hash_mismatch": [],
  "stub_mismatch": [],
  "missing_in_s3": [],
  "s3_checksum_mismatch": [],
  "local_checksum_mismatch": [],
  "missing_locally": [],
  "untracked": ["scratch.txt"],
  "ignored_count": 2,
  "stale_temp_files": []
}
```

`ok` is `false` whenever the total problem count (every category except `ignored_count`) is non-zero.

## Notes

- **Concurrency, and a load-bearing drain order.** The hash, s3, and stream pools are three
  independently bounded pools (see [`flow-pool-dispatch.md`](flow-pool-dispatch.md)), but they are not
  drained independently: `hashJobs.onIdle()` **must** be awaited before `s3Pool.onIdle()`, and that
  before `streamPool.onIdle()`, because each stage's own completion is what enqueues the next — draining
  a later pool first could miss jobs a still-running earlier stage hadn't enqueued yet. Each stage
  awaits `waitForRoom` on the next pool before dispatching, so backpressure runs from the stream pool
  all the way back to the merge-join.
- **The re-encrypt never writes anything.** Encryption is convergent (key and nonces derive from the
  master key and the content hash), so `localCiphertextChecksum` reproduces an upload's ciphertext
  exactly; it is checksummed chunk by chunk and discarded. `expectedHash` makes a file edited since it
  was hashed fail as a reported `localChecksumMismatch`, not a thrown error.
- **A real file is read twice** (hash, then re-encrypt), so the enumeration pass projects `2 × size`
  bytes for it and each stage calls `expectBytes(size)` at dispatch.
- **A stub's declared hash never touches the hash pool at all** — `readStubHash` is a cheap synchronous
  read, unlike hashing a real file's actual bytes, so that branch dispatches straight to `dispatchS3Check`
  with no hash job in between.
- **Every pool-reported bucket is explicitly re-sorted by path before returning** — dispatch order is
  not completion order once work is spread across three pools, so the merge-join's own path ordering
  would otherwise be lost by the time results are collected.
- **`--filter` scopes reporting and cost, never the walk itself.** The merge-join always walks the whole
  tree and the whole `entries` table regardless of `--filter` — a partial merge-join couldn't tell
  "filtered out" apart from "genuinely missing" on either side. Only whether an in-both-sides path
  actually gets rehashed/HEAD-checked/re-encrypted (and whether an fs-only/entry-only path gets reported at all) is
  gated by `--filter`.
- **Stale in-tree temp files are reported, never removed** — this command is read-only by design, and
  nothing else will ever clean these up either: the startup lock-hook sweep only reads `.sync1/`, and
  every ordinary walk excludes temp names by construction, so they are otherwise invisible dead space
  (a partially-decrypted `materialize` temp can be many GB).
- **On failure:** a pool error from any pool (a real hash-runner crash, a genuine S3 error rather
  than "object not found") is captured via `dispatchTracked`/`throwIfPoolErrored` and fails the whole
  command; anything actually _found wrong_ is reported in the result, not thrown.
- **Sub-flows:** [`flow-unlock-vault.md`](flow-unlock-vault.md), [`flow-pool-dispatch.md`](flow-pool-dispatch.md),
  [`flow-enumeration-pass.md`](flow-enumeration-pass.md), [`flow-encrypt-stream.md`](flow-encrypt-stream.md).
