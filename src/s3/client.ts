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
