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
   * Called once, with the BLAKE2b hex digest of the plaintext actually
   * read, at the same point `expectedHash`'s assertion would fire -- the
   * instant the last plaintext chunk has been consumed (or immediately,
   * for a zero-byte plaintext). Lets a caller that wants the *actual*
   * hash of whatever content was just encrypted (sanity_check, comparing
   * it against a recorded value itself rather than asking this module to
   * assert it) get it without the stream throwing on a mismatch.
   *
   * Compatible with `expectedHash` on the same call: if both are given and
   * the content doesn't match, `expectedHash`'s assertion still throws
   * (aborting the stream, withholding the final ciphertext chunk) before
   * this ever fires -- the two are never both satisfied for a mismatched
   * file. Harmless together because the hasher is finalized exactly once
   * either way; this just forwards that one digest to whichever of the two
   * callers asked for it.
   */
  onPlaintextHash?: (digestHex: string) => void;
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
  const { chunkSize = DEFAULT_CHUNK_SIZE, expectedHash, onPlaintextHash, signal } = options;
  const objectKey = deriveObjectKey(masterKey, context);
  const header = encodeHeader(context, chunkSize, totalPlaintextSize);
  const totalChunks = Math.ceil(totalPlaintextSize / chunkSize);

  async function* generate(): AsyncGenerator<Buffer> {
    const needsHash = expectedHash !== undefined || onPlaintextHash !== undefined;
    const hasher = needsHash ? new StreamingHasher() : undefined;

    // A zero-byte plaintext never enters the loop below, so the header *is*
    // the whole body and there would be nothing left to withhold once it
    // has been yielded. Its hash is knowable immediately, so check first.
    if (hasher && totalChunks === 0) {
      finishHash(hasher, expectedHash, onPlaintextHash);
    }

    if (totalChunks === 0) {
      // Nothing below will ever touch `sourceStream` -- `StreamByteReader`
      // is never asked to read a single byte from it.
      abandon(sourceStream);
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
        abandon(sourceStream);
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
      if (hasher && i === totalChunks - 1) {
        finishHash(hasher, expectedHash, onPlaintextHash);
      }
      yield encryptChunk(chunk, objectKey, i);
    }
  }

  return Readable.from(generate());
}

/**
 * Releases a source stream this generator is giving up on early -- never
 * read at all (a zero-byte plaintext) or abandoned mid-read (`signal`
 * aborted) -- without letting it crash the process later.
 *
 * `.destroy()` alone isn't enough for a real `fs.createReadStream`: its
 * `open()` is issued asynchronously and may still be in flight (Node
 * queues it, lazily, rather than opening synchronously at construction).
 * Destroying the stream doesn't cancel that queued syscall, and if the
 * file is removed before it resolves -- a test's own cleanup, a
 * concurrent delete -- it still completes, with ENOENT, and still emits
 * 'error' on the now-destroyed stream regardless. Confirmed directly
 * (destroy() alone measurably still crashes under this exact race), not
 * assumed from documentation. With nothing here ever having awaited that
 * eventual error, it would otherwise be a genuine unhandled 'error' event
 * -- Node's default for that is to crash the process outright. Attaching
 * a listener first, even a no-op one, is what an EventEmitter needs to
 * consider 'error' handled; this one is deliberately silent, since by the
 * time this runs the caller has already decided the stream's fate and has
 * nothing further to learn from an error it causes on the way out.
 */
function abandon(sourceStream: Readable): void {
  sourceStream.on("error", () => {});
  sourceStream.destroy();
}

/**
 * Finalizes `hasher` exactly once (libsodium's `generichash_final` can't be
 * called twice on the same state) and routes the one resulting digest to
 * whichever of `expectedHash`/`onPlaintextHash` the caller asked for --
 * `expectedHash`'s assertion runs first, so a mismatch throws (and
 * `onPlaintextHash` never fires) before the final ciphertext chunk is ever
 * emitted.
 */
function finishHash(
  hasher: StreamingHasher,
  expectedHash: string | undefined,
  onPlaintextHash: ((digestHex: string) => void) | undefined,
): void {
  const actual = hasher.digestHex();
  if (expectedHash !== undefined && actual !== expectedHash) {
    throw new Error(
      `plaintext hash ${actual} does not match the expected ${expectedHash} -- the file changed after it was hashed, so encrypting it under that hash's context would store the wrong content at a content-addressed key`,
    );
  }
  onPlaintextHash?.(actual);
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
