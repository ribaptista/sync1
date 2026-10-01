import type { Readable } from "node:stream";
import PQueue from "p-queue";
import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type StorageClass,
} from "@aws-sdk/client-s3";
import { Crc64Nvme } from "@aws-sdk/checksums/crc";
import { CorruptionError } from "../errors.js";
import type { Logger } from "../logger.js";
import { withS3Retry, type RetryNotice, type RetryOptions } from "./retry.js";
import { MULTIPART_THRESHOLD_BYTES, multipartPartSize } from "./client.js";
import { StreamByteReader } from "../crypto/streaming-codec.js";
import {
  createPoolErrorBox,
  dispatchTracked,
  throwIfPoolErrored,
  waitForRoom,
} from "../concurrency/pools.js";

/**
 * Replaces `@aws-sdk/lib-storage`'s `Upload`, for one reason: lib-storage
 * sends each part's body as a stream, and the SDK's retry middleware
 * refuses to retry any request whose body is a stream ("An error was
 * encountered in a non-retryable streaming request"). One failed part --
 * a single dropped connection -- therefore killed the whole multipart
 * upload, which `withS3Retry` could only restart from byte zero. For a
 * 100 GB file on a link that drops every hour or so, the chance every one
 * of ~10,000 parts lands in the same attempt is astronomically small: that
 * upload could never finish.
 *
 * Each part here is read into a **Buffer** before it is sent, so
 * `UploadPartCommand` is an ordinary retryable request and a failed part
 * is simply resent from the buffer already in hand -- no re-read, no
 * re-encryption, no restarting the file.
 */

/** At most this many parts are read ahead of what's already uploaded. Memory ~= this * partSize. */
const MAX_PARTS_IN_FLIGHT = 4;

/**
 * Thrown by `applyLocalChangesToCandidate` (`src/sync/apply-local-changes.ts`)
 * when an upload fails for a reason no amount of waiting fixes -- anything
 * `isTransientS3Error` (src/s3/retry.ts) doesn't recognize: access denied, a
 * missing bucket, a bug of ours. Transient failures never reach here --
 * `uploadObjectStream` retries those internally, per part, for as long as
 * it takes.
 *
 * Deliberately fatal to the **whole run**, the same escalation
 * `MirrorRequiredError` (src/fs/mirror-sink.ts) uses for an exhausted
 * mirror: an upload this run "gives up and leaves dirty" for the next sync
 * to retry would just waste that next sync retrying the same irrecoverable
 * error. Nothing committed this run can be trusted to be the last object
 * reachable before the misconfiguration, so nothing is committed at all --
 * a rerun, once the bucket/permissions/bug is fixed, starts clean.
 */
export class S3UploadFatalError extends Error {
  constructor(
    readonly paths: readonly string[],
    readonly hash: string,
    override readonly cause: unknown,
  ) {
    const which =
      paths.length === 1 ? `"${paths[0]}"` : `${paths.length} path(s) (${paths.join(", ")})`;
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `upload for ${which} failed with a non-transient S3 error: ${causeMessage} -- nothing was committed this run; fix the underlying problem and re-run sync`,
    );
    this.name = "S3UploadFatalError";
  }
}

/** How many attempts at a best-effort `AbortMultipartUpload` cleanup before giving up quietly. */
const ABORT_MULTIPART_ATTEMPTS = 3;

/** `exactOptionalPropertyTypes` forbids `{ abortSignal: undefined }`; omit the key entirely instead. */
function abortSignalOption(
  signal: AbortSignal | undefined,
): { abortSignal: AbortSignal } | undefined {
  return signal ? { abortSignal: signal } : undefined;
}

/** Builds a `RetryOptions` with only the keys that are actually defined, for the same reason. */
function retryOptionsFor(options: UploadObjectStreamOptions, part?: number): RetryOptions {
  const opts: RetryOptions = {};
  if (options.signal) opts.signal = options.signal;
  if (options.onRetry) {
    const onRetry = options.onRetry;
    opts.onRetry = part === undefined ? onRetry : (notice) => onRetry({ ...notice, part });
  }
  return opts;
}

export interface UploadObjectStreamOptions {
  /**
   * Cooperative cancellation shared with whatever else this object's
   * upload is coordinated with (a mirror write, the source read). Checked
   * before each part/PUT attempt and passed to `withS3Retry`, so an
   * already-doomed attempt (the mirror gave up, or a sibling part failed
   * irrecoverably) stops promptly instead of running to completion for
   * nothing.
   */
  signal?: AbortSignal;
  /** Forwarded from `withS3Retry`'s own `onRetry`, with the part number attached for multipart. */
  onRetry?: (notice: RetryNotice & { part?: number }) => void;
  /** Used only to report a failed best-effort `AbortMultipartUpload` cleanup; never required for correctness. */
  logger?: Logger;
}

/**
 * Verifies what S3 says it stored against what we streamed, throwing on any
 * disagreement.
 *
 * Worth being clear about what this adds, since it is narrower than it
 * looks. Reads are already protected end-to-end: every download decrypts
 * and re-hashes, the AEAD authenticates each chunk, and a mismatch raises
 * `CorruptionError`. What was missing is a check at *write* time -- until
 * now an upload trusted its 200, so an object S3 stored wrongly would only
 * be discovered on a later materialize, quite possibly after the local copy
 * had been stubified away. That is the window this closes.
 *
 * CRC64NVME's single-value-either-way property (see checksum.ts) is what
 * lets this be one function for both upload paths, rather than a
 * full-object comparison for one and a composite comparison for the other.
 */
function verifyStoredChecksum(key: string, expected: string, reported: string | undefined): void {
  if (reported === expected) return;
  // Silence is a failure, not a compatibility affordance. This function
  // exists to make an upload prove itself rather than trust its 200, and a
  // backend that reports nothing has proved nothing -- returning early here
  // would reopen the exact window described above, silently, for the
  // objects least likely to be noticed. The remedy is never to substitute
  // a locally computed value: convergent encryption means we could derive
  // the same number without a download, but recording it would make an
  // uncorroborated upload indistinguishable from a verified one, which is
  // worse than having no record at all. So a backend that does not
  // implement CRC64NVME is unsupported for writing -- already true in
  // practice (see the version pin in test/e2e/helpers/localstack.ts), now
  // enforced rather than assumed.
  if (reported === undefined || reported === "") {
    throw new CorruptionError(
      `S3 accepted "${key}" but reported no CRC64NVME checksum, so the upload was never verified against the ${expected} we computed -- this backend does not support the integrity guarantee sync1 requires for writes`,
    );
  }
  throw new CorruptionError(
    `S3 stored "${key}" with a CRC64NVME checksum of ${reported}, but the bytes we sent checksum to ${expected} -- the upload was corrupted in transit or at rest`,
  );
}

function crcBase64(buf: Buffer): Promise<string> {
  const crc = new Crc64Nvme();
  crc.update(buf);
  return crc.digest().then((d) => Buffer.from(d).toString("base64"));
}

/** Drains `body` into one Buffer. Only used below `MULTIPART_THRESHOLD_BYTES`, so the whole file fits comfortably. */
async function drainToBuffer(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function putSmallObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Readable,
  storageClass: StorageClass | undefined,
  options: UploadObjectStreamOptions,
): Promise<string> {
  const buffer = await drainToBuffer(body);
  const expected = await crcBase64(buffer);
  const result = await withS3Retry(
    () =>
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ChecksumAlgorithm: "CRC64NVME",
          StorageClass: storageClass,
        }),
        abortSignalOption(options.signal),
      ),
    retryOptionsFor(options),
  );
  verifyStoredChecksum(key, expected, result.ChecksumCRC64NVME);
  return expected;
}

/** Best-effort: never lets a cleanup failure replace the real error the caller is already propagating. */
async function abortMultipartUploadBestEffort(
  client: S3Client,
  bucket: string,
  key: string,
  uploadId: string,
  logger: Logger | undefined,
): Promise<void> {
  // Deliberately bounded, unlike `withS3Retry` -- this runs while the
  // caller is already failing for some other reason, so it must not turn
  // a quick, legitimate failure into an indefinite hang waiting out an
  // outage just to delete some parts. A lifecycle rule (see the tracked
  // follow-up) is the real backstop if every attempt here fails.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= ABORT_MULTIPART_ATTEMPTS; attempt++) {
    try {
      await client.send(
        new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
      );
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < ABORT_MULTIPART_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  logger?.warn(
    {
      bucket,
      key,
      uploadId,
      err: lastErr instanceof Error ? lastErr.message : String(lastErr),
    },
    "AbortMultipartUpload cleanup failed -- parts may be left on S3 until a lifecycle rule or `mirror catchup`-style sweep removes them",
  );
}

async function putLargeObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Readable,
  contentLength: number,
  storageClass: StorageClass | undefined,
  options: UploadObjectStreamOptions,
): Promise<string> {
  const partSize = multipartPartSize(contentLength);
  const create = await withS3Retry(
    () =>
      client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ChecksumAlgorithm: "CRC64NVME",
          ChecksumType: "FULL_OBJECT",
          StorageClass: storageClass,
        }),
        abortSignalOption(options.signal),
      ),
    retryOptionsFor(options),
  );
  const uploadId = create.UploadId;
  if (!uploadId) throw new Error(`CreateMultipartUpload for "${key}" returned no UploadId`);

  const crc = new Crc64Nvme();
  const reader = new StreamByteReader(body);
  const queue = new PQueue({ concurrency: MAX_PARTS_IN_FLIGHT });
  const errorBox = createPoolErrorBox();
  const uploadedParts: { PartNumber: number; ETag: string }[] = [];

  try {
    for (let partNumber = 1; ; partNumber++) {
      if (errorBox.hasError) break;
      options.signal?.throwIfAborted();
      // Checksummed here, in strict read order, before the chunk is handed
      // to a concurrent uploader: the full-object CRC64NVME has to reflect
      // the bytes in the order they occur in the stream, not the order
      // their UploadPart requests happen to settle in.
      const chunk = await reader.readExact(partSize);
      if (!chunk || chunk.length === 0) break;
      crc.update(chunk);
      const isLastPart = chunk.length < partSize;

      await waitForRoom(queue, MAX_PARTS_IN_FLIGHT);
      dispatchTracked(queue, errorBox, async () => {
        const result = await withS3Retry(
          () =>
            client.send(
              new UploadPartCommand({
                Bucket: bucket,
                Key: key,
                UploadId: uploadId,
                PartNumber: partNumber,
                Body: chunk,
                ChecksumAlgorithm: "CRC64NVME",
              }),
              abortSignalOption(options.signal),
            ),
          retryOptionsFor(options, partNumber),
        );
        if (!result.ETag) {
          throw new Error(
            `UploadPart ${partNumber} of "${key}" is missing an ETag -- check the bucket's CORS configuration exposes it`,
          );
        }
        uploadedParts.push({ PartNumber: partNumber, ETag: result.ETag });
      });

      if (isLastPart) break;
    }
    await queue.onIdle();
    throwIfPoolErrored(errorBox);
  } catch (err) {
    // `StreamByteReader` drives `body` by calling its async iterator's
    // `.next()` directly, not via a `for await` loop -- so simply stopping
    // those calls, which is all an early `break`/`throw` here does on its
    // own, leaves `body` neither destroyed nor read. That's the same class
    // of stuck-stream bug the tee hang (src/fs/mirror-sink.ts) was: when
    // `body` is a tee branch, an unread, undestroyed branch stalls the
    // shared source and the sink on the *other* branch with it. Destroying
    // it explicitly is what a `for await` would have done for free.
    if (!body.destroyed) body.destroy(err instanceof Error ? err : undefined);
    await abortMultipartUploadBestEffort(client, bucket, key, uploadId, options.logger);
    throw err;
  }

  const expected = Buffer.from(await crc.digest()).toString("base64");
  uploadedParts.sort((a, b) => a.PartNumber - b.PartNumber);
  const complete = await withS3Retry(
    () =>
      client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: uploadedParts },
          ChecksumCRC64NVME: expected,
          ChecksumType: "FULL_OBJECT",
        }),
        abortSignalOption(options.signal),
      ),
    retryOptionsFor(options),
  );
  verifyStoredChecksum(key, expected, complete.ChecksumCRC64NVME);
  return expected;
}

/**
 * Streams `body` to S3 and returns its verified CRC64NVME checksum.
 * Below `MULTIPART_THRESHOLD_BYTES`, a single buffered `PutObject`,
 * retried whole on a transient failure. At or above it, multipart with
 * each part buffered, sized by `multipartPartSize`, and retried
 * individually -- see the module doc for why that split exists.
 */
export async function uploadObjectStream(
  client: S3Client,
  bucket: string,
  key: string,
  body: Readable,
  contentLength: number,
  storageClass?: StorageClass,
  options: UploadObjectStreamOptions = {},
): Promise<string> {
  if (contentLength < MULTIPART_THRESHOLD_BYTES) {
    return putSmallObject(client, bucket, key, body, storageClass, options);
  }
  return putLargeObject(client, bucket, key, body, contentLength, storageClass, options);
}
