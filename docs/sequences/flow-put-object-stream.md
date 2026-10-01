# Flow: `uploadObjectStream`

**Derived from:** `src/s3/upload-object.ts`, `src/s3/client.ts`, `src/s3/retry.ts`

**Used by:** [`flow-apply-local-changes.md`](flow-apply-local-changes.md) (sync's upload phase)

Every content-object upload goes through one function that branches on size — a single buffered
`PutObjectCommand` below 32 MiB (`MULTIPART_THRESHOLD_BYTES`), a multipart upload of this module's own
(not `@aws-sdk/lib-storage`) at or above it — and both paths verify S3's own reported full-object
CRC64NVME against a value computed client-side, before returning. Every request this function sends is
wrapped in `withS3Retry`, which retries a transient failure (a dropped connection, a throttle) forever;
anything it still throws after that is non-transient, and the caller (see
[`flow-apply-local-changes.md`](flow-apply-local-changes.md)) treats that as fatal to the whole run, not
a per-file failure.

## Sequence

```mermaid
sequenceDiagram
    participant Caller
    participant UploadStream as uploadObjectStream
    participant Reader as StreamByteReader
    participant Queue as PQueue(concurrency=4)
    participant S3

    Caller->>UploadStream: uploadObjectStream(client, bucket, key, body, contentLength,<br/>storageClass?, { signal?, onRetry?, logger? })

    alt contentLength < 32 MiB
        UploadStream->>UploadStream: drainToBuffer(body) -- for-await into one Buffer
        UploadStream->>UploadStream: crc = CRC64NVME(buffer)
        UploadStream->>S3: withS3Retry(PutObjectCommand(buffer, ChecksumAlgorithm,<br/>StorageClass), abortSignal: signal)
        S3-->>UploadStream: result.ChecksumCRC64NVME
    else contentLength >= 32 MiB
        UploadStream->>S3: withS3Retry(CreateMultipartUploadCommand(ChecksumAlgorithm,<br/>ChecksumType: FULL_OBJECT, StorageClass))
        S3-->>UploadStream: UploadId
        loop until Reader reports EOF or errorBox has an error
            UploadStream->>Reader: readExact(multipartPartSize(contentLength))
            Reader-->>UploadStream: chunk (or throws, propagating a body/upstream failure)
            UploadStream->>UploadStream: crc.update(chunk) -- in read order, before dispatch
            UploadStream->>Queue: waitForRoom(4); dispatchTracked(...)
            Queue->>S3: withS3Retry(UploadPartCommand(chunk: Buffer, PartNumber,<br/>ChecksumAlgorithm), abortSignal: signal)
            S3-->>Queue: ETag (a failed part is retried from this same Buffer, not re-read)
        end
        UploadStream->>Queue: await queue.onIdle(); throwIfPoolErrored(errorBox)
        alt any part failed irrecoverably, or the Reader threw
            UploadStream->>S3: abortMultipartUploadBestEffort -- 3 bounded attempts,<br/>logs (never throws over the real error) if all fail
            UploadStream-->>Caller: rethrow the real cause
        else every part succeeded
            UploadStream->>S3: withS3Retry(CompleteMultipartUploadCommand(Parts,<br/>ChecksumCRC64NVME: crc.digest(), ChecksumType: FULL_OBJECT))
            S3-->>UploadStream: result.ChecksumCRC64NVME
        end
    end

    UploadStream->>UploadStream: verifyStoredChecksum(key, computed, result.ChecksumCRC64NVME)
    alt reported checksum matches computed
        UploadStream-->>Caller: return computed checksum
    else reported is absent/empty, or disagrees
        UploadStream-->>Caller: throw CorruptionError
    end
```

## Notes

- **Why not `@aws-sdk/lib-storage`:** its `Upload` class sends each part's body as a _stream_, and the
  SDK's retry middleware refuses to retry any request whose body is a stream ("An error was encountered
  in a non-retryable streaming request"). One dropped connection therefore failed the whole multipart
  upload, restartable only from byte zero — for a 100 GB file on a flaky link, the odds of every one of
  ~10,000 parts landing within the same attempt are astronomically small. Reading each part into a
  **Buffer** first (`StreamByteReader`, shared with `encryptStream` — see
  [`flow-encrypt-stream.md`](flow-encrypt-stream.md)) makes `UploadPartCommand` an ordinary retryable
  request, so a failed part is simply resent from the buffer already in hand.
- **Part size is explicit, not left to a default:** `multipartPartSize` (`src/s3/client.ts`) is
  `max(5 MiB, ceil(contentLength / 10,000))` — S3's own minimum part size and its 10,000-part ceiling.
  Needed because nothing reading a stream of unknown total length can size parts for itself; left
  unaccounted for, every multipart upload would be capped at 10,000 × 5 MiB ≈ 52.4 GB.
- **Concurrency:** at most 4 `UploadPart` requests are in flight at once (`MAX_PARTS_IN_FLIGHT`), via the
  same `waitForRoom`/`dispatchTracked`/`throwIfPoolErrored` idiom as every other pool in this codebase
  (see [`flow-pool-dispatch.md`](flow-pool-dispatch.md)) — the producer reading parts off `body` never
  gets more than 4 ahead of what the queue has actually dispatched. Memory is therefore bounded at
  roughly `4 * partSize` regardless of file size.
- **The checksum is computed in read order, ahead of dispatch**, not inside the (possibly reordered,
  concurrent) part uploaders — the full-object CRC64NVME has to reflect the bytes in the order they occur
  in the stream, not the order their requests happen to settle in.
- **On a part failing irrecoverably** (not a transient error, since those are retried inside
  `withS3Retry` forever): the producer loop's own `readExact` can also throw this way, if `body` itself
  fails (see [`flow-apply-local-changes.md`](flow-apply-local-changes.md) for how the caller tells that
  apart from an S3-side failure). Either way, `abortMultipartUploadBestEffort` tries up to 3 times to
  cancel the upload on S3 so no parts are left billing, logging (never throwing over) a failure to do
  even that — a lifecycle rule is the intended backstop if it still can't.
- **A missing or mismatched reported checksum is treated as corruption**, not a compatibility
  accommodation — a backend that doesn't implement CRC64NVME is unsupported for writing. Computing a
  substitute checksum locally instead (possible, since encryption is convergent) was considered and
  rejected: it would record a value nothing at S3 actually corroborated, while looking exactly like one
  that had been.
- **`signal` is cooperative, not forceful:** checked before each attempt in `withS3Retry` and passed as
  `abortSignal` to every `client.send`, so an already-doomed attempt (the mirror gave up, a sibling part
  failed) stops promptly rather than running every remaining retry to completion. It does not reach back
  to cancel a part's request that is already in flight when the signal fires mid-upload — that request
  is simply left to settle on its own and discarded, which was deliberately not changed to cancel
  outright, since doing so changes nothing observable (see [`flow-apply-local-changes.md`](flow-apply-local-changes.md)).
- **Sub-flows:** the body it reads is [`flow-encrypt-stream.md`](flow-encrypt-stream.md), which is where
  a size-mismatch or hash-mismatch failure actually originates.
