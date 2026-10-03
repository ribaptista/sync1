import PQueue from "p-queue";
import {
  S3Client,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  type StorageClass,
} from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";
import { withS3Retry, type RetryNotice, type RetryOptions } from "./retry.js";
import { encodeCopySource, COPY_MULTIPART_THRESHOLD_BYTES } from "./client.js";
import {
  verifyStoredChecksum,
  abortMultipartUploadBestEffort,
  abortSignalOption,
} from "./upload-object.js";
import {
  waitForRoom,
  createPoolErrorBox,
  dispatchTracked,
  throwIfPoolErrored,
} from "../concurrency/pools.js";

/**
 * Changes an object's storage class via self-copy (same bucket/key as
 * source and destination) -- the standard S3 mechanism for an in-place
 * class change, since there's no direct "set storage class" API. Metadata
 * is preserved (the default `MetadataDirective` behavior) since nothing
 * else about the object is changing.
 *
 * S3 caps a single `CopyObject`'s source at `COPY_MULTIPART_THRESHOLD_BYTES`
 * (5 GiB) -- above it, `CopyObjectCommand` fails outright with
 * `EntityTooLarge`. This is the fix for a real incident: every object over
 * that size failed both an `immediate-copy` to a colder class and a
 * `finalize-copy` after a restore (the restore itself had already been
 * paid for, and was re-requested on every subsequent `converge` run since
 * the finalize never landed) -- and since that error is fatal to the whole
 * `s3Pool` job, it aborted the entire converge run, leaving every object
 * after it unconverged too.
 *
 * Below the threshold, this sends the same bare `CopyObjectCommand` as
 * before -- no checksum verification, matching the previous behavior for
 * this path. Above it, `multipartCopyStorageClass` does the equivalent
 * multipart dance, with the completed object's checksum verified against
 * `expectedChecksum` (see its own doc comment).
 */
export async function copyObjectStorageClass(
  client: S3Client,
  bucket: string,
  key: string,
  storageClass: StorageClass,
  sizeBytes: number,
  expectedChecksum: string,
  options: CopyObjectStorageClassOptions = {},
): Promise<void> {
  const threshold = options.thresholdBytes ?? COPY_MULTIPART_THRESHOLD_BYTES;
  if (sizeBytes <= threshold) {
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: key,
        CopySource: encodeCopySource(bucket, key),
        StorageClass: storageClass,
      }),
    );
    return;
  }
  await multipartCopyStorageClass(
    client,
    bucket,
    key,
    storageClass,
    sizeBytes,
    expectedChecksum,
    options,
  );
}

export interface CopyObjectStorageClassOptions {
  /** Used only to report a failed best-effort `AbortMultipartUpload` cleanup, and transient-retry warnings; never required for correctness. */
  logger?: Logger;
  /** Cooperative cancellation, same contract as `UploadObjectStreamOptions.signal` (src/s3/upload-object.ts). */
  signal?: AbortSignal;
  /** Test-only override of `COPY_MULTIPART_THRESHOLD_BYTES` -- lets an e2e test force the multipart path on a small fixture rather than a multi-GiB one. */
  thresholdBytes?: number;
  /** Test-only override of the production part size (see `copyPartSize`'s own doc comment). */
  partSizeBytes?: number;
}

/** S3's hard ceiling on parts per multipart upload -- same limit `multipartPartSize` (src/s3/client.ts) observes for uploads. */
const MAX_COPY_PARTS = 10_000;

/**
 * S3's own enforced minimum size for every part but the last in any
 * multipart upload, uploads and copies alike.
 */
const MIN_COPY_PART_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Larger than `multipartPartSize`'s own upload default (nothing is read
 * into local memory for a copy -- every part is a server-side
 * `UploadPartCopy`, so there is no per-part buffer cost to weigh against
 * part count), so this favors fewer, larger parts: fewer round trips for
 * the overwhelmingly common case of a handful of multi-GiB video files.
 * Still capped by `MAX_COPY_PARTS`, the same way, for the same reason: a
 * part size fixed at 512 MiB alone would cap a single copy at
 * 512 MiB * 10,000 = ~5 TB, which is S3's own object size ceiling anyway,
 * so this is a belt-and-braces bound rather than one expected to bind in
 * practice.
 */
function copyPartSize(sizeBytes: number, override: number | undefined): number {
  if (override !== undefined) return override;
  const defaultPartSize = 512 * 1024 * 1024;
  return Math.max(MIN_COPY_PART_SIZE_BYTES, defaultPartSize, Math.ceil(sizeBytes / MAX_COPY_PARTS));
}

interface CopyByteRange {
  partNumber: number;
  start: number;
  /** Inclusive, matching `CopySourceRange`'s own `bytes=a-b` (HTTP Range) convention. */
  end: number;
}

function copyByteRanges(sizeBytes: number, partSize: number): CopyByteRange[] {
  const ranges: CopyByteRange[] = [];
  let partNumber = 1;
  for (let start = 0; start < sizeBytes; start += partSize, partNumber++) {
    const end = Math.min(start + partSize, sizeBytes) - 1;
    ranges.push({ partNumber, start, end });
  }
  return ranges;
}

/** How many `UploadPartCopy` requests run at once, for one object's copy. Deliberately a queue of its own, not `s3Pool` -- see the module doc comment below for why sharing it would deadlock. */
const COPY_PART_CONCURRENCY = 8;

function retryLogger(logger: Logger | undefined, what: string, part?: number) {
  return (notice: RetryNotice): void => {
    logger?.warn(
      {
        attempt: notice.attempt,
        delayMs: notice.delayMs,
        part,
        err: notice.error instanceof Error ? notice.error.message : String(notice.error),
      },
      `transient S3 failure ${what} -- retrying`,
    );
  };
}

/** Builds a `RetryOptions` with only the keys that are actually defined -- `exactOptionalPropertyTypes` forbids `{ signal: undefined }`, same reason as `upload-object.ts`'s own `retryOptionsFor`. */
function retryOptionsFor(
  options: CopyObjectStorageClassOptions,
  what: string,
  part?: number,
): RetryOptions {
  const opts: RetryOptions = { onRetry: retryLogger(options.logger, what, part) };
  if (options.signal) opts.signal = options.signal;
  return opts;
}

/**
 * The multipart equivalent of a single self-`CopyObject`, for an object
 * over `COPY_MULTIPART_THRESHOLD_BYTES`. `CreateMultipartUpload` on the
 * same key (with the target storage class), then one `UploadPartCopy` per
 * byte range, then `CompleteMultipartUpload` -- the object is replaced in
 * one atomic step, same as a plain `CopyObject` is.
 *
 * Runs every part's `UploadPartCopy` on a **queue private to this one
 * call**, not the caller's own `s3Pool`. `convergeStoragePolicies`
 * dispatches one job per object into `s3Pool`, and that job is what calls
 * this function -- so by the time this runs, it is already occupying one
 * of `s3Pool`'s own slots. If this function queued its parts into that
 * *same* pool and awaited them, it would be a pooled task waiting on other
 * work that needs the same pool: once every slot is held by such a task
 * (as happens the moment `s3QueueLimit` or more large objects are being
 * converged at once), no part can ever start, no outer task can ever
 * finish and free its slot, and the run hangs forever rather than erroring
 * -- silently, since nothing times out `s3Pool` by design (see
 * `dispatchTracked`'s own doc comment). A queue of its own costs nothing
 * extra: every part here is a server-side copy, not a buffered read, so
 * there is no memory reason to share a pool the way `uploadObjectStream`'s
 * `MAX_PARTS_IN_FLIGHT` queue has to limit buffered bytes in flight.
 *
 * **Integrity.** `CompleteMultipartUploadCommand` is sent with
 * `ChecksumType: "FULL_OBJECT"` and the *expected* `ChecksumCRC64NVME` --
 * S3 itself verifies the parts it combined against that value, and also
 * reports its own computed checksum back on success, which
 * `verifyStoredChecksum` (src/s3/upload-object.ts, shared with the upload
 * path) compares again on this end. `FULL_OBJECT`, not the default
 * composite-of-parts mode, is what keeps the object's own recorded
 * checksum identical to what it was before the copy -- a composite
 * checksum would be a different value for the same bytes purely because
 * the part boundaries changed, breaking the comparison every later
 * `sanity_check`/`verifyRemote` HEAD makes against
 * `objects.ciphertext_checksum`.
 *
 * On any failure, `AbortMultipartUploadCommand` (best-effort) before
 * rethrowing, so a failed copy never leaves a billed, half-finished
 * upload sitting on the object's own key.
 */
async function multipartCopyStorageClass(
  client: S3Client,
  bucket: string,
  key: string,
  storageClass: StorageClass,
  sizeBytes: number,
  expectedChecksum: string,
  options: CopyObjectStorageClassOptions,
): Promise<void> {
  const create = await withS3Retry(
    () =>
      client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          StorageClass: storageClass,
          ChecksumAlgorithm: "CRC64NVME",
          ChecksumType: "FULL_OBJECT",
        }),
        abortSignalOption(options.signal),
      ),
    retryOptionsFor(options, "creating multipart copy"),
  );
  const uploadId = create.UploadId;
  if (!uploadId) {
    throw new Error(`CreateMultipartUpload for "${key}" (storage-class copy) returned no UploadId`);
  }

  const partSize = copyPartSize(sizeBytes, options.partSizeBytes);
  const ranges = copyByteRanges(sizeBytes, partSize);
  const copiedParts: { PartNumber: number; ETag: string }[] = [];
  const queue = new PQueue({ concurrency: COPY_PART_CONCURRENCY });
  const errorBox = createPoolErrorBox();

  try {
    for (const range of ranges) {
      if (errorBox.hasError) break;
      options.signal?.throwIfAborted();
      await waitForRoom(queue, COPY_PART_CONCURRENCY);
      dispatchTracked(queue, errorBox, async () => {
        const result = await withS3Retry(
          () =>
            client.send(
              new UploadPartCopyCommand({
                Bucket: bucket,
                Key: key,
                UploadId: uploadId,
                PartNumber: range.partNumber,
                CopySource: encodeCopySource(bucket, key),
                CopySourceRange: `bytes=${range.start}-${range.end}`,
              }),
              abortSignalOption(options.signal),
            ),
          retryOptionsFor(options, "copying a storage-class part", range.partNumber),
        );
        const etag = result.CopyPartResult?.ETag;
        if (!etag) {
          throw new Error(
            `UploadPartCopy ${range.partNumber} of "${key}" is missing an ETag -- check the bucket's CORS configuration exposes it`,
          );
        }
        copiedParts.push({ PartNumber: range.partNumber, ETag: etag });
      });
    }
    await queue.onIdle();
    throwIfPoolErrored(errorBox);
  } catch (err) {
    await abortMultipartUploadBestEffort(client, bucket, key, uploadId, options.logger);
    throw err;
  }

  copiedParts.sort((a, b) => a.PartNumber - b.PartNumber);
  let complete;
  try {
    complete = await withS3Retry(
      () =>
        client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: copiedParts },
            ChecksumCRC64NVME: expectedChecksum,
            ChecksumType: "FULL_OBJECT",
          }),
          abortSignalOption(options.signal),
        ),
      retryOptionsFor(options, "completing a storage-class copy"),
    );
  } catch (err) {
    await abortMultipartUploadBestEffort(client, bucket, key, uploadId, options.logger);
    throw err;
  }
  verifyStoredChecksum(key, expectedChecksum, complete.ChecksumCRC64NVME);
}
