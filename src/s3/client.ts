import type { Readable } from "node:stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  RestoreObjectCommand,
  DeleteObjectCommand,
  type S3ClientConfig,
  type StorageClass,
  type Tier,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

export interface S3ClientOptions {
  /** Required-but-nullable rather than optional: sidesteps exactOptionalPropertyTypes
   *  friction at call sites that just forward a possibly-undefined CLI flag. */
  region: string | undefined;
  /** Set for LocalStack/S3-compatible backends; omit for real AWS S3. */
  endpoint: string | undefined;
}

export function createS3Client(opts: S3ClientOptions): S3Client {
  const config: S3ClientConfig = { region: opts.region ?? "us-east-1" };
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
 * sweet-spot guidance. Comfortably above `Upload`'s enforced 5 MiB minimum
 * part size (so an object just over the threshold isn't needlessly split
 * into many tiny parts) and comfortably below the point where a failed
 * single-PUT retry becomes expensive on a flaky connection.
 */
export const MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024;

/**
 * Streaming counterpart to `putObject` -- content-object uploads have no
 * CAS/conditional semantics to preserve (dedup is already checked before any
 * upload is attempted). Below `MULTIPART_THRESHOLD_BYTES`, a plain
 * PutObjectCommand with a precomputed `contentLength` (the chunked codec's
 * fixed per-chunk overhead makes this exact, computed upfront by the
 * caller via `encryptedSize`) is enough. At or above it, S3's ~5GiB
 * single-PUT limit means a real backup file (this vault exists specifically
 * to hold multi-GB/100GB files) needs multipart upload -- `@aws-sdk/
 * lib-storage`'s `Upload` class accepts the same streamed body directly (no
 * local temp-file staging) and manages the part uploads internally.
 */
export async function putObjectStream(
  client: S3Client,
  bucket: string,
  key: string,
  body: Readable,
  contentLength: number,
): Promise<void> {
  if (contentLength < MULTIPART_THRESHOLD_BYTES) {
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: contentLength }),
    );
    return;
  }

  const upload = new Upload({
    client,
    params: { Bucket: bucket, Key: key, Body: body },
  });
  await upload.done();
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
}

export async function headObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<HeadResult | null> {
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (!result.ETag) throw new Error(`HeadObject for "${key}" did not return an ETag`);
    const head: HeadResult = { etag: result.ETag };
    if (result.StorageClass !== undefined) head.storageClass = result.StorageClass;
    if (result.Restore !== undefined) head.restore = result.Restore;
    return head;
  } catch (err) {
    if (err instanceof Error && err.name === "NotFound") return null;
    throw err;
  }
}

function encodeCopySource(bucket: string, key: string): string {
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${bucket}/${encodedKey}`;
}

/**
 * Self-copy (same bucket/key as source and destination) that only changes
 * the object's storage class -- the standard S3 mechanism for an in-place
 * class change, since there's no direct "set storage class" API. Metadata
 * is preserved (the default `MetadataDirective` behavior) since we're not
 * changing anything else about the object.
 */
export async function copyObjectStorageClass(
  client: S3Client,
  bucket: string,
  key: string,
  storageClass: StorageClass,
): Promise<void> {
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: key,
      CopySource: encodeCopySource(bucket, key),
      StorageClass: storageClass,
    }),
  );
}

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
