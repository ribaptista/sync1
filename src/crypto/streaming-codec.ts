import { Readable } from "node:stream";
import {
  encodeHeader,
  decodeHeader,
  chunkCount,
  plaintextChunkLength,
  encryptChunk,
  decryptChunk,
  deriveObjectKey,
  AEAD_TAG_BYTES,
  DEFAULT_CHUNK_SIZE,
} from "./chunked-codec.js";
import { StreamingHasher } from "./hash.js";

/**
 * Streaming counterparts to chunked-codec.ts's whole-buffer encryptBuffer/
 * decryptBuffer -- built from the same per-chunk primitives, so a multi-GB
 * video is never held fully in memory (see docs/architecture/
 * vault-and-encryption.md). Never touches the filesystem or S3 directly:
 * callers supply/consume plain Node Readables.
 */

/**
 * Accumulates arbitrary-sized chunks from a stream until an exact byte
 * count is available. Exported for `src/s3/upload-object.ts`, which reads
 * fixed-size multipart parts off the same kind of stream this module
 * encrypts into -- re-buffering chunk boundaries is exactly this class's
 * job, regardless of what the fixed size is for.
 */
export class StreamByteReader {
  private buffered = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Buffer>;
  private done = false;

  constructor(stream: AsyncIterable<Buffer>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  /** Returns exactly `n` bytes, fewer only at a clean EOF, or null if nothing is left at all. */
  async readExact(n: number): Promise<Buffer | null> {
    while (this.buffered.length < n && !this.done) {
      const { value, done } = await this.iterator.next();
      if (done) {
        this.done = true;
        break;
      }
      this.buffered = Buffer.concat([this.buffered, value]);
    }
    if (this.buffered.length === 0) return null;
    const take = Math.min(n, this.buffered.length);
    const result = this.buffered.subarray(0, take);
    this.buffered = this.buffered.subarray(take);
    return result;
  }
}

/** The exact total byte size `encryptStream` will produce, computable before any encryption happens. */
export function encryptedSize(
  totalPlaintextSize: number,
  contextLength: number,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): number {
  const headerSize = 4 + 1 + 1 + contextLength + 4 + 8;
  const totalChunks = Math.ceil(totalPlaintextSize / chunkSize);
  return headerSize + totalPlaintextSize + totalChunks * AEAD_TAG_BYTES;
}

export interface EncryptStreamOptions {
  chunkSize?: number;
  /**
   * BLAKE2b hex of the plaintext this stream is *supposed* to carry. When
   * given, the plaintext is hashed as it is read and the stream errors
   * rather than emitting its final chunk if the two disagree.
   *
   * Exists because the hash and the bytes are read at different times. A
   * content object's `context` is its own content hash, computed during
   * `update_cache` at the start of a sync; the bytes are read from disk
   * during the upload phase, potentially hours later on a large vault. A
   * file edited in between would be encrypted under the *old* hash's
   * context and stored at the old hash's key — breaking the invariant that
   * an object at key H decrypts to content hashing to H, which local
   * dedup, the `verifyRemote` HEAD shortcut, and the mirror's
   * skip-if-exists all rely on.
   *
   * The size-changing case is already caught by `readExact` below. This
   * covers the silent one: a same-size edit produces a correct byte count,
   * a matching `ContentLength`, and a checksum both ends agree on, so
   * nothing else in the pipeline can tell. It would surface only on a much
   * later `materialize`, which does verify decrypted content against the
   * recorded hash — quite possibly after `stubify` removed the local copy.
   */
  expectedHash?: string;
  /**
   * Job-level coordination from the caller: when the sink(s) this stream
   * feeds have given up for good (the mirror failed, S3 gave up), the read
   * has to stop too, rather than going on reading and encrypting bytes
   * nothing downstream will ever consume. Checked once per chunk, not
   * continuously -- the chunk already being read when the signal fires is
   * still allowed to finish, which is simpler than threading cancellation
   * into `StreamByteReader` itself and costs at most one chunk's worth of
   * wasted work.
   */
  signal?: AbortSignal;
}

/**
 * Encrypts a plaintext stream chunk-by-chunk. `totalPlaintextSize` must be
 * known upfront (a `fs.statSync` away for a caller reading from a file) --
 * it's embedded in the header and is what makes `encryptedSize` computable
 * without touching the source, which in turn is what lets an S3 upload
 * supply a precise `ContentLength` without buffering. `sourceStream`'s own
 * chunk boundaries don't need to align to `chunkSize` -- they're re-buffered
 * internally via `StreamByteReader`.
 */
export function encryptStream(
  sourceStream: Readable,
  totalPlaintextSize: number,
  masterKey: Buffer,
  context: Buffer,
  options: EncryptStreamOptions = {},
): Readable {
  const { chunkSize = DEFAULT_CHUNK_SIZE, expectedHash, signal } = options;
  const objectKey = deriveObjectKey(masterKey, context);
  const header = encodeHeader(context, chunkSize, totalPlaintextSize);
  const totalChunks = Math.ceil(totalPlaintextSize / chunkSize);

  async function* generate(): AsyncGenerator<Buffer> {
    const hasher = expectedHash === undefined ? undefined : new StreamingHasher();

    // A zero-byte plaintext never enters the loop below, so the header *is*
    // the whole body and there would be nothing left to withhold once it
    // has been yielded. Its hash is knowable immediately, so check first.
    if (hasher && expectedHash !== undefined && totalChunks === 0) {
      assertPlaintextHash(hasher, expectedHash);
    }

    yield header;
    const reader = new StreamByteReader(sourceStream);
    for (let i = 0; i < totalChunks; i++) {
      // Checked once per chunk, not continuously -- see `signal`'s doc on
      // `EncryptStreamOptions`. Explicitly destroying `sourceStream` (not
      // just throwing out of this generator) is what actually releases the
      // open file handle; throwing alone would leave it open until GC,
      // same as the hang this whole mechanism exists to prevent.
      if (signal?.aborted) {
        sourceStream.destroy();
        signal.throwIfAborted();
      }
      const len = i === totalChunks - 1 ? totalPlaintextSize - chunkSize * i : chunkSize;
      const chunk = await reader.readExact(len);
      if (!chunk || chunk.length !== len) {
        throw new Error(
          `chunk ${i}: expected ${len} plaintext bytes, got ${chunk?.length ?? 0} (source file changed size during read?)`,
        );
      }
      hasher?.update(chunk);
      // The seam this whole mechanism turns on: the final plaintext chunk
      // is in hand, so the hash is complete -- and its ciphertext has not
      // been emitted yet. Throwing here leaves the body short of the
      // ContentLength the caller declared, so the SDK aborts the request
      // mid-body and S3 discards an incomplete PUT (or, above the
      // multipart threshold, never calls CompleteMultipartUpload). The
      // object is therefore never created, rather than created and then
      // cleaned up -- no window in which another machine's verifyRemote
      // HEAD could adopt it, and no poisoned content key if the cleanup
      // itself failed.
      if (hasher && expectedHash !== undefined && i === totalChunks - 1) {
        assertPlaintextHash(hasher, expectedHash);
      }
      yield encryptChunk(chunk, objectKey, i);
    }
  }

  return Readable.from(generate());
}

function assertPlaintextHash(hasher: StreamingHasher, expectedHash: string): void {
  const actual = hasher.digestHex();
  if (actual === expectedHash) return;
  throw new Error(
    `plaintext hash ${actual} does not match the expected ${expectedHash} -- the file changed after it was hashed, so encrypting it under that hash's context would store the wrong content at a content-addressed key`,
  );
}

/** Decrypts an encoded object stream chunk-by-chunk, verifying each chunk's AEAD tag as it goes. */
export function decryptStream(sourceStream: Readable, masterKey: Buffer): Readable {
  async function* generate(): AsyncGenerator<Buffer> {
    const reader = new StreamByteReader(sourceStream);

    const prefix = await reader.readExact(6);
    if (!prefix || prefix.length < 6) {
      throw new Error("buffer too short to contain a chunked-encryption header");
    }
    const contextLen = prefix.readUInt8(5);
    const rest = await reader.readExact(contextLen + 4 + 8);
    if (!rest || rest.length < contextLen + 4 + 8) {
      throw new Error("buffer too short to contain the full chunked-encryption header");
    }
    const header = decodeHeader(Buffer.concat([prefix, rest]));

    const objectKey = deriveObjectKey(masterKey, header.context);
    const totalChunks = chunkCount(header);
    for (let i = 0; i < totalChunks; i++) {
      const expectedLen = plaintextChunkLength(header, i) + AEAD_TAG_BYTES;
      const ciphertextChunk = await reader.readExact(expectedLen);
      if (!ciphertextChunk || ciphertextChunk.length !== expectedLen) {
        throw new Error(
          `chunk ${i}: expected ${expectedLen} ciphertext bytes, got ${ciphertextChunk?.length ?? 0} (truncated object?)`,
        );
      }
      yield decryptChunk(ciphertextChunk, objectKey, i);
    }
  }

  return Readable.from(generate());
}
