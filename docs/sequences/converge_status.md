# `sync1 converge` / `sync1 status`

**Derived from:** `src/commands/converge.ts`, `src/commands/status.ts`,
`src/sync/converge-storage-policies.ts`, `src/s3/copy-object.ts`

One shared function, `convergeStoragePolicies`, with a single `apply` boolean as the only difference
between the two commands: `status` (`apply: false`) reports what would change; `converge`
(`apply: true`) actually issues the S3 calls. Needs no password — HEAD/copy/restore never decrypt
anything, and storage policies are read from the already-locally-decrypted `state.db` (opened
read-only). The outer loop's own `headObject`/`restoreObject` calls use none of
[`flow-s3-retry.md`](flow-s3-retry.md)'s unbounded retry — a transient failure there just fails the
run, and the next `converge`/`status` invocation re-evaluates everything from scratch.
`copyObjectStorageClass` is the one exception: above S3's 5 GiB single-`CopyObject` limit it falls back
to a multipart copy whose own `CreateMultipartUpload`/`UploadPartCopy`/`CompleteMultipartUpload` calls
each _do_ use `withS3Retry` internally (see its own section below) — a transient failure on one part
retries just that part, not the whole run. Both commands run after the ordinary lock/root-resolution
preamble (see [`flow-preamble.md`](flow-preamble.md)), omitted below since it never varies.

## Sequence

```mermaid
sequenceDiagram
    participant CLI as converge / status
    participant State as state.db (read-only)
    participant Pool as s3 pool
    participant S3
    participant Archive as flow-archive-status

    CLI->>State: listNonDefaultByPriority(); getDefault()
    CLI->>State: onTotalKnown(countDistinctHashesMatchingGlob(filter)) -- offline denominator

    loop each DISTINCT hash matching --filter (dedup: one evaluation per object, not per path)
        CLI->>State: iterateByHash(hash) -- every path referencing it, regardless of --filter scope
        CLI->>CLI: resolveHashTargetClass(paths, nonDefaultPolicies, defaultPolicy)
        opt paths disagree on target class
            CLI->>CLI: conflicts.push({hash, paths, targetClass}) -- warmest-wins already resolved it,<br/>this is just surfaced for visibility
        end
        CLI->>State: objectsRepo.get(hash) -- missing -> CorruptionError
        CLI->>Pool: waitForRoom; dispatchTracked(job)
        Pool->>S3: headObject(key)
        Pool->>Archive: currentClass = head.storageClass; classifyArchiveStatus(head)
        Pool->>Pool: decideStorageClassAction(currentClass, targetClass, archiveStatus)
        alt already-correct
            Pool->>Pool: counts.alreadyCorrect++
        else immediate-copy (target is colder, or warmer+already "immediate")
            Pool->>Pool: counts.changedImmediate++
            opt apply
                Pool->>Pool: copySizeBytes = head.contentLength ?? encryptedSize(objectRow.size, HASH_BYTES)
                Pool->>S3: copyObjectStorageClass(key, targetClass, copySizeBytes,<br/>objectRow.ciphertext_checksum) -- see the sub-sequence below
            end
        else needs-restore-request
            Pool->>Pool: counts.restoreRequested++
            opt apply
                Pool->>S3: restoreObject(key, days:7, tier:Standard)
            end
        else restore-ongoing
            Pool->>Pool: counts.restorePending++ -- no action possible either way
        else finalize-copy (restore-ready)
            Pool->>Pool: counts.finalized++
            opt apply
                Pool->>Pool: copySizeBytes = head.contentLength ?? encryptedSize(objectRow.size, HASH_BYTES)
                Pool->>S3: copyObjectStorageClass(key, targetClass, copySizeBytes,<br/>objectRow.ciphertext_checksum)
            end
        end
        Pool->>CLI: checked++; onProgress(checked)
    end

    CLI->>Pool: await s3Pool.onIdle(); throwIfPoolErrored()
```

## Sub-sequence — `copyObjectStorageClass` above 5 GiB

`copySizeBytes` is the real, encrypted S3 object size (what the limit below actually measures) --
`objectRow.size` alone is the plaintext size recorded at upload time, so it's only ever a fallback for a
HEAD response that omitted `ContentLength`.

```mermaid
sequenceDiagram
    participant Job as converge's dispatched job (holds one s3Pool slot)
    participant S3
    participant PartQueue as private part queue (new PQueue, NOT s3Pool)

    Job->>Job: sizeBytes <= COPY_MULTIPART_THRESHOLD_BYTES (5 GiB)?
    alt at or below the threshold
        Job->>S3: CopyObjectCommand (unchanged from before this fix)
    else above the threshold
        Job->>S3: CreateMultipartUploadCommand (StorageClass, ChecksumAlgorithm:CRC64NVME,<br/>ChecksumType:FULL_OBJECT) -- withS3Retry
        loop each ~512 MiB byte range (capped at 10,000 parts, same ceiling as uploads)
            Job->>PartQueue: waitForRoom; dispatchTracked(part job)
            PartQueue->>S3: UploadPartCopyCommand (CopySource, CopySourceRange:bytes=a-b) -- withS3Retry,<br/>retries only this one part on a transient failure
        end
        Job->>PartQueue: await queue.onIdle(); throwIfPoolErrored()
        alt any part failed irrecoverably
            Job->>S3: AbortMultipartUploadCommand (best-effort) -- then rethrow
        else every part succeeded
            Job->>S3: CompleteMultipartUploadCommand (sorted parts, ChecksumCRC64NVME:expected,<br/>ChecksumType:FULL_OBJECT) -- withS3Retry
            Job->>Job: verifyStoredChecksum(key, expected, complete.ChecksumCRC64NVME) -- throws<br/>CorruptionError on any mismatch (shared with the upload path)
        end
    end
```

**Why a private queue, not `s3Pool`:** the job calling `copyObjectStorageClass` is itself one of
`s3Pool`'s own dispatched tasks, already occupying a slot. Queuing this object's parts into that same
pool and awaiting them would be a pooled task waiting on other work that needs the same pool -- once
enough large objects are being converged at once to fill every `s3Pool` slot with such a task, no part
could ever start, no outer task could ever finish and free its slot, and the run would hang forever
rather than erroring (nothing times out `s3Pool` by design). A queue private to each call costs nothing
extra: every part is a server-side copy, never a buffered read, so there's no memory reason to share a
pool the way the upload path's own part queue has to bound buffered bytes in flight.

## Output

```json
{
  "ok": true,
  "already_correct": 40,
  "changed_immediate": 2,
  "restore_requested": 1,
  "restore_pending": 0,
  "finalized": 0,
  "conflicts": [{ "hash": "ab12...", "paths": ["a.txt", "b.txt"], "target_class": "STANDARD" }]
}
```

Always `ok: true`, for both commands — a warmest-wins conflict is reported, not a failure (the object
already has a deterministic target class; the conflict is informational visibility into _why_). A
thrown error (missing object, unsupported storage class from S3) fails the command outright instead.

## Notes

- **Concurrency:** the outer loop's own work (resolving every path sharing a hash, warmest-wins
  conflict detection, the objects-table lookup) is synchronous SQL, never spanning an `await`. Only the
  per-hash tail — HEAD, classify, conditional copy/restore — is genuine network I/O, dispatched to
  `s3Pool` (see [`flow-pool-dispatch.md`](flow-pool-dispatch.md)).
- **Dedup-aware by construction:** the loop iterates _distinct hashes_, not paths — a shared object's
  target class is resolved from every path referencing it, regardless of `--filter`'s own scope, since
  warmest-wins has to see the whole picture to resolve correctly. See
  `docs/architecture/ignore-and-storage-policies.md`.
- **A colder target is always an unconditional `immediate-copy`** — no archive-status branching needed,
  since moving to a colder class from any current state is always a plain, immediate copy (see
  [`flow-archive-status.md`](flow-archive-status.md)'s notes on `decideStorageClassAction`). Only a
  _warmer_ target branches on the object's current restore status.
- **`status` and `converge` classify identically — the counts `status` reports are exactly what
  `converge --apply` would do**, since both call the same function with the same evaluation; only
  whether the S3 side effect is actually issued differs.
- **On failure:** a missing `objects` row for a referenced hash, a missing S3 object at HEAD time, or an
  unsupported storage class all throw `CorruptionError`/`Error` synchronously inside the dispatched job,
  captured by `dispatchTracked` and surfaced via `throwIfPoolErrored` after `s3Pool.onIdle()` — failing
  the whole command, with no partial per-object reporting.
- **An object over 5 GiB used to fail every copy outright** (S3's own `EntityTooLarge` on a single
  `CopyObject`), which — being an ordinary thrown error inside the dispatched job — aborted the whole
  run via the same `throwIfPoolErrored` path above, leaving every object after it in iteration order
  unconverged. `copyObjectStorageClass` now falls back to a multipart copy above that size instead (see
  the sub-sequence above) — the one place in this command where a single hash's own action can issue
  more than one kind of S3 request.
- **Sub-flows:** [`flow-pool-dispatch.md`](flow-pool-dispatch.md), [`flow-archive-status.md`](flow-archive-status.md).
