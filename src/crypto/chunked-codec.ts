import sodium from "sodium-native";
import { deriveSubkey } from "./subkey.js";

/**
 * Chunked, randomly-accessible authenticated encryption. Used for both
 * content objects (convergent: `context` = the plaintext's content hash, so
 * identical content always encrypts identically, which is what makes
 * storage-level dedup possible) and state.db snapshots (non-convergent:
 * `context` = a random per-upload salt).
 *
 * Each chunk is encrypted independently with crypto_aead_xchacha20poly1305_ietf
 * under a key+nonce deterministically derived from (objectKey, chunkIndex) —
 * deliberately NOT crypto_secretstream, which ratchets state chunk-to-chunk
 * and would make random access impossible. Fixed chunk size + a fixed-size
 * header means chunk N's ciphertext offset is computable directly, without
 * scanning: this is what a future random-access reader (e.g. a video
 * streaming utility, seeking via S3 Range GETs) needs.
 *
 * Wire format:
 *   [4B magic "SY1C"][1B format version][1B context length N][N bytes context]
 *   [4B chunk size][8B total plaintext size]
 *   [chunk_0 ciphertext+16B tag][chunk_1 ciphertext+16B tag]...
 */

const MAGIC = Buffer.from("SY1C", "ascii");
const FORMAT_VERSION = 1;
const CHUNK_KDF_CONTEXT = "sy1obj01"; // exactly crypto_kdf_CONTEXTBYTES (8) chars

const AEAD_KEY_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES;
const AEAD_NONCE_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
export const AEAD_TAG_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;

export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB

export class CryptoAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoAuthError";
  }
}

export interface ChunkedHeader {
  formatVersion: number;
  context: Buffer;
  chunkSize: number;
  totalPlaintextSize: number;
  /** byte length of the header itself, i.e. where chunk 0's ciphertext starts */
  headerSize: number;
}

/** Derives the per-object key from the master key and a context (hash bytes or random salt). */
export function deriveObjectKey(masterKey: Buffer, context: Buffer): Buffer {
  const out = Buffer.alloc(32);
  sodium.crypto_generichash(out, context, masterKey);
  return out;
}

function deriveChunkKeyNonce(
  objectKey: Buffer,
  chunkIndex: number,
): { key: Buffer; nonce: Buffer } {
  const combined = deriveSubkey(
    objectKey,
    chunkIndex,
    CHUNK_KDF_CONTEXT,
    AEAD_KEY_BYTES + AEAD_NONCE_BYTES,
  );
  return {
    key: combined.subarray(0, AEAD_KEY_BYTES),
    nonce: combined.subarray(AEAD_KEY_BYTES, AEAD_KEY_BYTES + AEAD_NONCE_BYTES),
  };
}

export function encryptChunk(plaintext: Buffer, objectKey: Buffer, chunkIndex: number): Buffer {
  const { key, nonce } = deriveChunkKeyNonce(objectKey, chunkIndex);
  const ciphertext = Buffer.alloc(plaintext.length + AEAD_TAG_BYTES);
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ciphertext, plaintext, null, null, nonce, key);
  return ciphertext;
}

export function decryptChunk(ciphertext: Buffer, objectKey: Buffer, chunkIndex: number): Buffer {
  const { key, nonce } = deriveChunkKeyNonce(objectKey, chunkIndex);
  const plaintext = Buffer.alloc(ciphertext.length - AEAD_TAG_BYTES);
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      plaintext,
      null,
      ciphertext,
      null,
      nonce,
      key,
    );
  } catch {
    throw new CryptoAuthError(`chunk ${chunkIndex} failed authentication (tampered or wrong key)`);
  }
  return plaintext;
}

export function encodeHeader(
  context: Buffer,
  chunkSize: number,
  totalPlaintextSize: number,
): Buffer {
  if (context.length > 255) {
    throw new Error(`context too long: ${context.length} bytes (max 255)`);
  }
  const header = Buffer.alloc(4 + 1 + 1 + context.length + 4 + 8);
  let offset = 0;
  MAGIC.copy(header, offset);
  offset += 4;
  header.writeUInt8(FORMAT_VERSION, offset);
  offset += 1;
  header.writeUInt8(context.length, offset);
  offset += 1;
  context.copy(header, offset);
  offset += context.length;
  header.writeUInt32LE(chunkSize, offset);
  offset += 4;
  header.writeBigUInt64LE(BigInt(totalPlaintextSize), offset);
  return header;
}

export function decodeHeader(buf: Buffer): ChunkedHeader {
  if (buf.length < 6) {
    throw new Error("buffer too short to contain a chunked-encryption header");
  }
  if (!buf.subarray(0, 4).equals(MAGIC)) {
    throw new Error("bad magic bytes: not a sync1 chunked-encryption object");
  }
  const formatVersion = buf.readUInt8(4);
  if (formatVersion !== FORMAT_VERSION) {
    throw new Error(`unsupported chunked-encryption format version ${formatVersion}`);
  }
  const contextLen = buf.readUInt8(5);
  const tailOffset = 6 + contextLen;
  if (buf.length < tailOffset + 4 + 8) {
    throw new Error("buffer too short to contain the full chunked-encryption header");
  }
  const context = Buffer.from(buf.subarray(6, tailOffset));
  const chunkSize = buf.readUInt32LE(tailOffset);
  const totalPlaintextSize = Number(buf.readBigUInt64LE(tailOffset + 4));
  return { formatVersion, context, chunkSize, totalPlaintextSize, headerSize: tailOffset + 4 + 8 };
}

export function chunkCount(
  header: Pick<ChunkedHeader, "chunkSize" | "totalPlaintextSize">,
): number {
  return Math.ceil(header.totalPlaintextSize / header.chunkSize);
}

/** Byte range of chunk N's ciphertext (including its tag) within the encoded object. */
export function chunkByteRange(
  header: Pick<ChunkedHeader, "chunkSize" | "headerSize">,
  chunkIndex: number,
): { start: number; end: number } {
  const ciphertextChunkSize = header.chunkSize + AEAD_TAG_BYTES;
  const start = header.headerSize + chunkIndex * ciphertextChunkSize;
  return { start, end: start + ciphertextChunkSize };
}

function plaintextChunkLength(header: ChunkedHeader, chunkIndex: number): number {
  const isLastChunk = chunkIndex === chunkCount(header) - 1;
  if (!isLastChunk) return header.chunkSize;
  const remainder = header.totalPlaintextSize % header.chunkSize;
  return remainder === 0 ? header.chunkSize : remainder;
}

/** Whole-buffer convenience wrapper — encrypts an entire plaintext buffer in one call. */
export function encryptBuffer(
  plaintext: Buffer,
  masterKey: Buffer,
  context: Buffer,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Buffer {
  const objectKey = deriveObjectKey(masterKey, context);
  const header = encodeHeader(context, chunkSize, plaintext.length);
  const totalChunks = Math.ceil(plaintext.length / chunkSize);
  const parts: Buffer[] = [header];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, plaintext.length);
    parts.push(encryptChunk(plaintext.subarray(start, end), objectKey, i));
  }
  return Buffer.concat(parts);
}

/** Whole-buffer convenience wrapper — decrypts an entire encoded object in one call. */
export function decryptBuffer(encoded: Buffer, masterKey: Buffer): Buffer {
  const header = decodeHeader(encoded);
  const objectKey = deriveObjectKey(masterKey, header.context);
  const totalChunks = chunkCount(header);
  const plaintextParts: Buffer[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const { start, end } = chunkByteRange(header, i);
    const ciphertextChunk = encoded.subarray(start, end);
    const expectedLen = plaintextChunkLength(header, i) + AEAD_TAG_BYTES;
    if (ciphertextChunk.length !== expectedLen) {
      throw new Error(
        `chunk ${i}: expected ${expectedLen} ciphertext bytes, got ${ciphertextChunk.length} (truncated object?)`,
      );
    }
    plaintextParts.push(decryptChunk(ciphertextChunk, objectKey, i));
  }
  return Buffer.concat(plaintextParts);
}
