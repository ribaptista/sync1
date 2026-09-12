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

/**
 * Streaming counterparts to chunked-codec.ts's whole-buffer encryptBuffer/
 * decryptBuffer -- built from the same per-chunk primitives, so a multi-GB
 * video is never held fully in memory (see docs/architecture/
 * vault-and-encryption.md). Never touches the filesystem or S3 directly:
 * callers supply/consume plain Node Readables.
 */

/** Accumulates arbitrary-sized chunks from a stream until an exact byte count is available. */
class StreamByteReader {
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
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Readable {
  const objectKey = deriveObjectKey(masterKey, context);
  const header = encodeHeader(context, chunkSize, totalPlaintextSize);
  const totalChunks = Math.ceil(totalPlaintextSize / chunkSize);

  async function* generate(): AsyncGenerator<Buffer> {
    yield header;
    const reader = new StreamByteReader(sourceStream);
    for (let i = 0; i < totalChunks; i++) {
      const len = i === totalChunks - 1 ? totalPlaintextSize - chunkSize * i : chunkSize;
      const chunk = await reader.readExact(len);
      if (!chunk || chunk.length !== len) {
        throw new Error(
          `chunk ${i}: expected ${len} plaintext bytes, got ${chunk?.length ?? 0} (source file changed size during read?)`,
        );
      }
      yield encryptChunk(chunk, objectKey, i);
    }
  }

  return Readable.from(generate());
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
