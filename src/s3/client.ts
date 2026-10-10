import type { Readable } from "node:stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  RestoreObjectCommand,
  DeleteObjectCommand,
  type S3ClientConfig,
  type Tier,
} from "@aws-sdk/client-s3";
import type { Logger as SmithyLogger } from "@smithy/types";
import type { Logger } from "../logger.js";

export interface S3ClientOptions {
  /** Required-but-nullable rather than optional: sidesteps exactOptionalPropertyTypes
   *  friction at call sites that just forward a possibly-undefined CLI flag. */
  region: string | undefined;
  /** Set for LocalStack/S3-compatible backends; omit for real AWS S3. */
  endpoint: string | undefined;
  /**
   * Routes the SDK's own diagnostics (retry warnings, the "non-retryable
   * streaming request" notice -- see `src/s3/retry.ts`'s doc comment) into
   * this logger instead of `console`. Smithy's retry middleware checks
   * `context.logger instanceof NoOpLogger` and falls back to `console`
   * specifically when nothing was configured here, which is how one of
   * this vault's own real incidents went completely unlogged: the only
   * trace of it was a line printed to the terminal with no path, no
   * attempt count, nothing a later `grep` over `sync.log` could ever find.
   * Optional, and only wired up by `sync` so far (see `createS3Client`'s
   * other callers) -- every other command can opt in the same way.
   */
  logger?: Logger;
}

/**
 * How deep `primitivesOnly` recurses before giving up on a value -- not a
 * limit this SDK's own records are expected to reach (they're a handful of
 * levels at most), just a cheap backstop against a cyclic object looping
 * forever.
 */
const PRIMITIVES_ONLY_MAX_DEPTH = 6;

/**
 * Strips a value down to what's safe to write into a structured log line:
 * strings, numbers, booleans, `null`, and plain objects/arrays built only
 * from those (recursively). Everything else -- a `Buffer`, a stream, any
 * other class instance, a function -- is dropped rather than serialized.
 *
 * Exists because `@smithy`'s own request/response logging middleware
 * (`loggerMiddleware.js`) calls `logger.info({ clientName, commandName,
 * input, output, metadata })` with the *whole* input/output objects, and
 * nothing in the SDK trims them for us: its own sensitive-data filter
 * (`schemaLogFilter`) only ever redacts fields the service's schema marks
 * `sensitive`, and S3's `Body` isn't one of those -- it's a `StreamingBlob`
 * with trait `{ streaming: 1 }`, which passes straight through. Since this
 * project's uploads hand the SDK a `Buffer` holding the whole object (or
 * whole part) being uploaded, `input.Body` there is the actual ciphertext --
 * writing it to a log line verbatim would mean every synced byte lands in
 * `--log`'s file a second time, as a giant JSON array of numbers.
 *
 * Deliberately the simplest rule that avoids that: no special-casing by
 * type or size (a `Buffer`, a `Readable`, and a custom class instance are
 * all just "not a primitive" and vanish the same way), at the cost of one
 * known gap -- a large plain array of primitives (`CompleteMultipartUpload`'s
 * `Parts` list, up to 10,000 small `{ETag, PartNumber}` entries) is kept in
 * full, since it's already made only of the values this function keeps.
 * That's one long `--verbose` line for a large multipart upload, not a
 * leak of file content.
 */
function primitivesOnly(value: unknown, depth = 0): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  // `undefined` specifically, not just "anything not caught above": an SDK
  // record routinely has `undefined`-valued fields (an absent `output` on
  // some responses, a metadata field with no value this time), and
  // `Object.getPrototypeOf(undefined)` throws -- confirmed directly, a real
  // sync run crashed on exactly this ("Cannot convert undefined or null to
  // object") the first time this function met one. Dropped, same as any
  // other non-primitive -- there is nothing to keep.
  if (value === undefined) return undefined;
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (depth >= PRIMITIVES_ONLY_MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => primitivesOnly(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  // A plain object literal only -- a Buffer, a Readable, a Date, or any
  // other class instance has a different prototype and is dropped instead,
  // the same as a function or a symbol would be.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const sanitizedItem = primitivesOnly(item, depth + 1);
      if (sanitizedItem !== undefined) sanitized[key] = sanitizedItem;
    }
    return sanitized;
  }
  return undefined;
}

/**
 * Adapts this project's structured pino logger (`debug(context, msg)`) to
 * the shape `@smithy/types` expects (`debug(...content: unknown[])`,
 * matching `console`'s own variadic signature).
 *
 * The SDK calls this two different ways. Its own retry/streaming
 * diagnostics (`src/s3/retry.ts`'s doc comment) pass a plain message string,
 * sometimes followed by extra values -- folded into one structured `args`
 * field rather than interpolated into the message string, per this repo's
 * own logging convention (see AGENTS.md). Its request/response logging
 * middleware instead calls `logger.info({ clientName, commandName, input,
 * output, metadata })` (or `{ ..., error }` on failure) with **no message at
 * all**, just that one record -- `String(record)` on that produces exactly
 * `"[object Object]"`, discarding everything useful. That record is run
 * through `primitivesOnly` and logged as its own `sdk` field instead, with a
 * short, fixed message (`"s3 <commandName>"`, or `"... failed"` once the
 * record carries an `error`) so every such line is still searchable by
 * command.
 */
function smithyLoggerAdapter(logger: Logger): SmithyLogger {
  const forward =
    (level: "trace" | "debug" | "info" | "warn" | "error") =>
    (...content: unknown[]): void => {
      const [message, ...rest] = content;
      const context: Record<string, unknown> = { source: "aws-sdk" };
      if (rest.length > 0) context.args = primitivesOnly(rest);

      if (message !== null && typeof message === "object") {
        const record = message as Record<string, unknown>;
        const commandName = typeof record.commandName === "string" ? record.commandName : "command";
        const failed = "error" in record;
        context.sdk = primitivesOnly(record);
        logger[level](context, `s3 ${commandName}${failed ? " failed" : ""}`);
        return;
      }

      logger[level](context, typeof message === "string" ? message : String(message));
    };
  return {
    trace: forward("trace"),
    debug: forward("debug"),
    info: forward("info"),
    warn: forward("warn"),
    error: forward("error"),
  };
}

export function createS3Client(opts: S3ClientOptions): S3Client {
  const config: S3ClientConfig = {
    region: opts.region ?? "us-east-1",
    // Every streamed upload body (encryptStream, see src/crypto/streaming-
    // codec.ts) yields its ~50-byte chunked-encryption header as its own
    // first read, ahead of much larger per-chunk data. The SDK's default
    // flexible-checksums behavior wraps a streamed body in AWS's
    // "aws-chunked" transfer encoding using the *underlying stream's own*
    // read sizes as the wire chunk boundaries, and AWS S3 rejects any
    // non-final chunk under 8192 bytes ("InvalidChunkSizeError") -- hit on
    // real S3 for every single-PUT (non-multipart) upload, since the tiny
    // header read is never the last chunk. `requestStreamBufferSize`
    // (>= 8192) is the SDK's own documented fix: below this size, reads are
    // buffered together before chunk-encoding. LocalStack doesn't enforce
    // the minimum, which is why this never surfaced in the e2e suite.
    requestStreamBufferSize: 65_536,
  };
  if (opts.logger) {
    config.logger = smithyLoggerAdapter(opts.logger);
  }
  if (opts.endpoint) {
    config.endpoint = opts.endpoint;
    // path-style is required by LocalStack and most S3-compatible backends;
    // real AWS S3 also accepts it, so this is safe whenever an endpoint is given.
    config.forcePathStyle = true;
    config.credentials = { accessKeyId: "test", secretAccessKey: "test" };
  }
  return new S3Client(config);
}

export class CasConflictError extends Error {
  constructor(key: string) {
    super(`CAS precondition failed for key "${key}" — a newer version already exists`);
    this.name = "CasConflictError";
  }
}

export interface PutOptions {
  /** Require the key not already exist (used for the very first write of a key). */
  ifNoneMatchAny?: boolean;
  /** Require the key's current ETag to match this value (optimistic concurrency). */
  ifMatch?: string;
}

/**
 * A conditional PutObject — the CAS primitive the whole sync design depends
 * on. Confirmed (Task 0 spike) to work against localstack/localstack:4.0;
 * `latest` requires a Pro license and 3.8 lacks If-Match support.
 */
export async function putObjectCas(
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  opts: PutOptions = {},
): Promise<{ etag: string }> {
  try {
    const result = await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        IfNoneMatch: opts.ifNoneMatchAny ? "*" : undefined,
        IfMatch: opts.ifMatch,
      }),
    );
    if (!result.ETag) {
      throw new Error(`PutObject for "${key}" did not return an ETag`);
    }
    return { etag: result.ETag };
  } catch (err) {
    if (err instanceof Error && err.name === "PreconditionFailed") {
      throw new CasConflictError(key);
    }
    throw err;
  }
}

export async function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
): Promise<void> {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}

/**
 * Below this size, a plain single-shot PutObject is strictly better (one
 * request, no part-numbering/completion overhead) -- matches S3's own
 * sweet-spot guidance. Comfortably above S3's enforced 5 MiB minimum part
 * size (so an object just over the threshold isn't needlessly split into
 * many tiny parts) and comfortably below the point where a failed
 * single-PUT retry becomes expensive on a flaky connection.
 */
export const MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024;

/** S3's hard ceiling on parts per multipart upload. */
const MAX_MULTIPART_PARTS = 10_000;

/** S3's own enforced minimum size for every part but the last. */
const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Part size for a multipart upload of `contentLength` bytes: the minimum,
 * unless that would need more than S3's 10,000 parts.
 *
 * Has to be passed explicitly. The uploader (src/s3/upload-object.ts) sizes
 * each part's read off this, so it can only ever use the minimum -- left
 * unaccounted for, that caps every multipart upload at 10,000 x 5 MiB =
 * ~52.4 GB. A real 96 GB file reached exactly that byte, after which the
 * upload could never complete.
 *
 * Memory scales with it: the uploader keeps up to 4 parts in flight at
 * once, so a 96 GB object holds ~40 MB in flight, and S3's 5 TB object
 * ceiling would hold ~2 GB.
 */
export function multipartPartSize(contentLength: number): number {
  return Math.max(MIN_PART_SIZE_BYTES, Math.ceil(contentLength / MAX_MULTIPART_PARTS));
}

export async function getObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<{ body: Buffer; etag: string } | null> {
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!result.Body) throw new Error(`GetObject for "${key}" returned no body`);
    const bytes = await result.Body.transformToByteArray();
    if (!result.ETag) throw new Error(`GetObject for "${key}" did not return an ETag`);
    return { body: Buffer.from(bytes), etag: result.ETag };
  } catch (err) {
    if (err instanceof Error && err.name === "NoSuchKey") return null;
    throw err;
  }
}

/**
 * Streaming counterpart to `getObject` -- exposes the response body as a
 * live Node Readable instead of eagerly buffering it, so a large content
 * object's decrypt-and-write never needs the whole thing in memory (see
 * docs/architecture/vault-and-encryption.md).
 */
export async function getObjectStream(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<{ body: Readable; etag: string } | null> {
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!result.Body) throw new Error(`GetObject for "${key}" returned no body`);
    if (!result.ETag) throw new Error(`GetObject for "${key}" did not return an ETag`);
    // In the Node.js runtime (the only runtime this project runs in), Body
    // is always a Readable, never the browser ReadableStream/Blob variants.
    return { body: result.Body as Readable, etag: result.ETag };
  } catch (err) {
    if (err instanceof Error && err.name === "NoSuchKey") return null;
    throw err;
  }
}

export interface HeadResult {
  etag: string;
  storageClass?: string;
  restore?: string;
  /**
   * The object's full-object CRC64NVME checksum, base64 -- the exact value
   * `uploadObjectStream` (src/s3/upload-object.ts) computes and returns on upload, and what
   * `objects.ciphertext_checksum` stores (see src/s3/checksum.ts and
   * 0006_add_object_ciphertext_checksum.sql). Absent unless S3 actually
   * has one recorded for the object: an object uploaded before this vault
   * asked for checksums at all has none to report.
   */
  checksumCrc64Nvme?: string;
  /**
   * The object's size in bytes. Added for `copyObjectStorageClass`
   * (src/s3/copy-object.ts): converge already HEADs every object before
   * deciding its action, so this is what lets it pick single-`CopyObject`
   * vs. multipart without a second request.
   */
  contentLength?: number;
}

export async function headObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<HeadResult | null> {
  try {
    // ChecksumMode "ENABLED" is required to get `ChecksumCRC64NVME` back at
    // all -- without it S3 omits the field even for an object that does
    // have one stored, which is exactly how the aborted-run recovery path
    // in apply-local-changes.ts ended up recording a NULL checksum for an
    // object S3 could have told it about. Costs nothing extra: HeadObject
    // already requires the same s3:GetObject permission either way.
    const result = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }),
    );
    if (!result.ETag) throw new Error(`HeadObject for "${key}" did not return an ETag`);
    const head: HeadResult = { etag: result.ETag };
    if (result.StorageClass !== undefined) head.storageClass = result.StorageClass;
    if (result.Restore !== undefined) head.restore = result.Restore;
    if (result.ChecksumCRC64NVME !== undefined) {
      head.checksumCrc64Nvme = result.ChecksumCRC64NVME;
    }
    if (result.ContentLength !== undefined) {
      head.contentLength = result.ContentLength;
    }
    return head;
  } catch (err) {
    if (err instanceof Error && err.name === "NotFound") return null;
    throw err;
  }
}

/**
 * Shared by the single-`CopyObject` path here and `copy-object.ts`'s
 * multipart one -- both self-copy (same bucket/key as source and
 * destination), so both need the same `CopySource` encoding.
 */
export function encodeCopySource(bucket: string, key: string): string {
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${bucket}/${encodedKey}`;
}

/**
 * S3's hard limit on a single `CopyObject`'s source size -- above this, a
 * self-copy to change storage class has to go through the multipart
 * copy path instead (`copyObjectStorageClass` in src/s3/copy-object.ts).
 * Exactly the value S3 itself reports in `EntityTooLarge`'s error message
 * ("The specified copy source is larger than the maximum allowable size
 * for a copy source: 5368709120").
 */
export const COPY_MULTIPART_THRESHOLD_BYTES = 5 * 1024 ** 3;

export interface RestoreOptions {
  days: number;
  tier: Tier;
}

/** Requests a temporary restored copy of an archived (Glacier/Deep Archive) object. */
export async function restoreObject(
  client: S3Client,
  bucket: string,
  key: string,
  opts: RestoreOptions,
): Promise<void> {
  await client.send(
    new RestoreObjectCommand({
      Bucket: bucket,
      Key: key,
      RestoreRequest: { Days: opts.days, Tier: opts.tier },
    }),
  );
}

/** Permanent deletion -- used only by `gc`, only after a CAS-guarded commit removing the reference succeeded. */
export async function deleteObject(client: S3Client, bucket: string, key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** True if no object exists under `prefix` — used by init_remote's empty-vault check. */
export async function isPrefixEmpty(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<boolean> {
  const result = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }),
  );
  return (result.KeyCount ?? 0) === 0;
}
