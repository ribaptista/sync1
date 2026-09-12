import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import sodium from "sodium-native";
import { encryptBuffer, CryptoAuthError } from "../../../src/crypto/chunked-codec.js";
import {
  encryptStream,
  decryptStream,
  encryptedSize,
} from "../../../src/crypto/streaming-codec.js";

const TEST_CHUNK_SIZE = 16; // small, so multi-chunk scenarios are easy to construct

function randomMasterKey(): Buffer {
  const key = Buffer.alloc(32);
  sodium.randombytes_buf(key);
  return key;
}

function contentHashContext(content: Buffer): Buffer {
  const out = Buffer.alloc(32);
  sodium.crypto_generichash(out, content);
  return out;
}

/** Wraps a buffer as a Readable delivering it in deliberately-misaligned pieces. */
function chunkyReadable(data: Buffer, pieceSize: number): Readable {
  const pieces: Buffer[] = [];
  for (let i = 0; i < data.length; i += pieceSize) {
    pieces.push(data.subarray(i, Math.min(i + pieceSize, data.length)));
  }
  return Readable.from(pieces.length > 0 ? pieces : [Buffer.alloc(0)]);
}

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

describe("streaming codec", () => {
  it("encryptStream matches encryptBuffer's output byte-for-byte", async () => {
    const masterKey = randomMasterKey();
    const plaintext = Buffer.from("A".repeat(16) + "B".repeat(16) + "C".repeat(7));
    const context = contentHashContext(plaintext);

    const whole = encryptBuffer(plaintext, masterKey, context, TEST_CHUNK_SIZE);

    // Deliberately misaligned source chunking (3 bytes at a time), to exercise
    // the internal re-buffering rather than happening to align with chunkSize.
    const streamed = await collect(
      encryptStream(
        chunkyReadable(plaintext, 3),
        plaintext.length,
        masterKey,
        context,
        TEST_CHUNK_SIZE,
      ),
    );

    expect(streamed.equals(whole)).toBe(true);
  });

  it("decryptStream matches decryptBuffer's output, from a misaligned source stream", async () => {
    const masterKey = randomMasterKey();
    const plaintext = Buffer.from("A".repeat(16) + "B".repeat(16) + "C".repeat(7));
    const context = contentHashContext(plaintext);
    const encoded = encryptBuffer(plaintext, masterKey, context, TEST_CHUNK_SIZE);

    const decrypted = await collect(decryptStream(chunkyReadable(encoded, 5), masterKey));
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("round-trips through encryptStream then decryptStream directly", async () => {
    const masterKey = randomMasterKey();
    const plaintext = Buffer.from("streamed round trip content, several chunks long here");
    const context = contentHashContext(plaintext);

    const encoded = await collect(
      encryptStream(
        chunkyReadable(plaintext, 7),
        plaintext.length,
        masterKey,
        context,
        TEST_CHUNK_SIZE,
      ),
    );
    const decrypted = await collect(decryptStream(chunkyReadable(encoded, 9), masterKey));

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("round-trips an empty buffer", async () => {
    const masterKey = randomMasterKey();
    const plaintext = Buffer.alloc(0);
    const context = contentHashContext(plaintext);

    const encoded = await collect(
      encryptStream(chunkyReadable(plaintext, 4), 0, masterKey, context, TEST_CHUNK_SIZE),
    );
    const decrypted = await collect(decryptStream(chunkyReadable(encoded, 4), masterKey));
    expect(decrypted).toHaveLength(0);
  });

  it("fails authentication when a ciphertext byte is tampered with", async () => {
    const masterKey = randomMasterKey();
    const plaintext = Buffer.from("A".repeat(16) + "B".repeat(16));
    const context = contentHashContext(plaintext);
    const encoded = encryptBuffer(plaintext, masterKey, context, TEST_CHUNK_SIZE);

    const tampered = Buffer.from(encoded);
    const headerSize = tampered.length - plaintext.length - 2 * 16; // 2 chunks, 16-byte tags
    tampered.writeUInt8(tampered.readUInt8(headerSize) ^ 0xff, headerSize);

    await expect(collect(decryptStream(chunkyReadable(tampered, 6), masterKey))).rejects.toThrow(
      CryptoAuthError,
    );
  });

  it("encryptedSize predicts the exact encoded length", () => {
    const masterKey = randomMasterKey();
    const plaintext = Buffer.from("A".repeat(16) + "B".repeat(16) + "C".repeat(7));
    const context = contentHashContext(plaintext);
    const encoded = encryptBuffer(plaintext, masterKey, context, TEST_CHUNK_SIZE);

    expect(encryptedSize(plaintext.length, context.length, TEST_CHUNK_SIZE)).toBe(encoded.length);
  });
});
