# Flow: `putObjectStream`

**Derived from:** `src/s3/client.ts`, `src/s3/checksum.ts`

**Used by:** [`flow-apply-local-changes.md`](flow-apply-local-changes.md) (sync's upload phase)

Every content-object upload goes through one function that branches on size — a single `PutObjectCommand`
below 32 MiB (`MULTIPART_THRESHOLD_BYTES`), lib-storage's `Upload` at or above it — and both paths verify
S3's own reported CRC64NVME against a value computed client-side as the ciphertext streams past, before
returning. A body that errors mid-stream (the source file changed, or its content stopped matching the
hash it is being stored under — see [`flow-encrypt-stream.md`](flow-encrypt-stream.md)) is turned into an
immediate abort, not an unhandled rejection and not a lingering socket.

## Sequence

```mermaid
sequenceDiagram
    participant Caller
    participant PutStream as putObjectStream
    participant Tap as UploadChecksumTap
    participant Body as body stream (encryptStream)
    participant S3

    Caller->>PutStream: putObjectStream(client, bucket, key, body, contentLength, storageClass?)
    PutStream->>Tap: tap(body) -- passes every byte through untouched while hashing it
    PutStream->>PutStream: firstBodyError(tapped, aborter) -- races the upload<br/>against the body's own 'error' event

    alt contentLength < 32 MiB
        PutStream->>S3: PutObjectCommand(tapped, ChecksumAlgorithm: CRC64NVME, StorageClass: storageClass), abortSignal
    else contentLength >= 32 MiB
        PutStream->>S3: lib-storage Upload(tapped, ChecksumAlgorithm, StorageClass: storageClass), abortController
        note right of S3: multipart: CreateMultipartUpload / UploadPart×N / CompleteMultipartUpload
    end
    note over PutStream: storageClass is undefined for every caller but sync's own new-content<br/>dispatch (see flow-apply-local-changes.md) -- omitted, S3 defaults to STANDARD

    par the PUT/Upload itself
        S3-->>PutStream: result (ChecksumCRC64NVME, or undefined)
    and the body stream
        Body-->>Tap: chunks, until EOF or an abort thrown mid-generator
        alt body throws (size mismatch, or expectedHash mismatch)
            Body-->>PutStream: 'error' event -> firstBodyError's promise rejects
            PutStream->>S3: aborter.abort() -- cancels the in-flight request /<br/>fires AbortMultipartUpload, so no parts are left billing
        end
    end

    alt body error won the race
        PutStream-->>Caller: rethrow the body's error -- nothing was ever stored
    else upload completed
        PutStream->>Tap: await tap.checksum() -- CRC64NVME of everything sent
        PutStream->>PutStream: verifyStoredChecksum(key, computed, result.ChecksumCRC64NVME)
        alt reported checksum matches computed
            PutStream-->>Caller: return computed checksum
        else reported is absent/empty, or disagrees
            PutStream-->>Caller: throw CorruptionError
        end
    end
```

## Notes

- **Concurrency:** the upload/PUT and the body-error watcher race each other (`Promise.race`) for the
  duration of one object's transfer; this is the only concurrency inside the function itself. The
  function as a whole is one job inside sync's `stream` pool (see
  [`flow-pool-dispatch.md`](flow-pool-dispatch.md)).
- **On failure:**
  - A body error aborts the in-flight request/multipart upload immediately via `AbortController` — the
    object is never created at S3 at all, not created-then-cleaned-up. Above the 32 MiB threshold this
    also makes lib-storage issue its own `AbortMultipartUpload`, so no orphaned parts are left for S3 to
    keep billing for.
  - A missing or mismatched reported checksum is treated as **corruption**, not a compatibility
    accommodation — a backend that doesn't implement CRC64NVME is unsupported for writing. This is a
    deliberate hardening: computing a substitute checksum locally instead (possible, since encryption is
    convergent) was considered and rejected, because it would record a value nothing at S3 actually
    corroborated while looking exactly like one that had been.
  - Without the abort-on-body-error machinery, a body error below the 32 MiB threshold used to surface
    as an **unhandled `'error'` event that killed the process** before the caller's own `try/catch`
    could see it — the run's `--json` summary was never written at all. And even once caught, the SDK's
    own request would sit waiting on a body that would never send another byte until its socket timed
    out, roughly a minute per failed object.
- **Sub-flows:** the body it streams is [`flow-encrypt-stream.md`](flow-encrypt-stream.md), which is
  where the size-mismatch and hash-mismatch aborts this diagram reacts to actually originate.
