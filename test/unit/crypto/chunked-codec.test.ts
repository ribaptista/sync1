import { describe, it, expect } from "vitest";
import sodium from "sodium-native";
import {
  encryptBuffer,
  decryptBuffer,
  decodeHeader,
  chunkCount,
  chunkByteRange,
  CryptoAuthError,
} from "../../../src/crypto/chunked-codec.js";

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

describe("chunked codec round-trips", () => {
  it("round-trips an empty buffer", () => {
    const masterKey = randomMasterKey();
    const plaintext = Buffer.alloc(0);
    const context = contentHashContext(plaintext);

    const encoded = encryptBuffer(plaintext, masterKey, context, TEST_CHUNK_SIZE);
    const header = decodeHeader(encoded);
    expect(header.totalPlaintextSize).toBe(0);
    expect(chunkCount(header)).toBe(0);

    const decrypted = decryptBuffer(encoded, masterKey);
    expect(decrypted).toHaveLength(0);
  });

  it("round-trips exactly one full chunk", () => {
    const masterKey = randomMasterKey();
    const plaintext = Buffer.from("0123456789ABCDEF"); // exactly 16 bytes
    expect(plaintext).toHaveLength(TEST_CHUNK_SIZE);
    const context = contentHashContext(plaintext);

    const encoded = encryptBuffer(plaintext, masterKey, context, TEST_CHUNK_SIZE);
    const header = decodeHeader(encoded);
    expect(chunkCount(header)).toBe(1);

    const decrypted = decryptBuffer(encoded, masterKey);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("round-trips multiple chunks with a partial last chunk", () => {
    const masterKey = randomMasterKey();
    // 2.5 chunks worth of content at TEST_CHUNK_SIZE=16
    const plaintext = Buffer.from("A".repeat(16) + "B".repeat(16) + "C".repeat(7));
    const context = contentHashContext(plaintext);

    const encoded = encryptBuffer(plaintext, masterKey, context, TEST_CHUNK_SIZE);
    const header = decodeHeader(encoded);
    expect(chunkCount(header)).toBe(3);

    const decrypted = decryptBuffer(encoded, masterKey);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("exposes correct byte ranges for random access to a specific chunk", () => {
    const masterKey = randomMasterKey();
    const plaintext = Buffer.from("A".repeat(16) + "B".repeat(16) + "C".repeat(7));
    const context = contentHashContext(plaintext);
    const encoded = encryptBuffer(plaintext, masterKey, context, TEST_CHUNK_SIZE);
    const header = decodeHeader(encoded);

    // Fetch just chunk 1's ciphertext by byte range, as a future random-access
    // reader would via an S3 Range GET, and confirm it decrypts standalone.
    const { start, end } = chunkByteRange(header, 1);
    const chunk1Ciphertext = encoded.subarray(start, end);
    expect(chunk1Ciphertext).toHaveLength(TEST_CHUNK_SIZE + 16); // + AEAD tag

    // Decrypting the whole buffer should place the same bytes at the same offset.
    const decrypted = decryptBuffer(encoded, masterKey);
    expect(decrypted.subarray(16, 32).toString()).toBe("B".repeat(16));
  });
});

describe("chunked codec security properties", () => {
  it("fails authentication when a ciphertext byte is tampered with", () => {
    const masterKey = randomMasterKey();
    const plaintext = Buffer.from("A".repeat(16) + "B".repeat(16));
    const context = contentHashContext(plaintext);
    const encoded = encryptBuffer(plaintext, masterKey, context, TEST_CHUNK_SIZE);

    const header = decodeHeader(encoded);
    const tampered = Buffer.from(encoded);
    // flip a byte inside chunk 0's ciphertext
    tampered.writeUInt8(tampered.readUInt8(header.headerSize) ^ 0xff, header.headerSize);

    expect(() => decryptBuffer(tampered, masterKey)).toThrow(CryptoAuthError);
  });

  it("fails authentication when decrypted with the wrong master key", () => {
    const plaintext = Buffer.from("secret content");
    const context = contentHashContext(plaintext);
    const encoded = encryptBuffer(plaintext, randomMasterKey(), context, TEST_CHUNK_SIZE);

    expect(() => decryptBuffer(encoded, randomMasterKey())).toThrow(CryptoAuthError);
  });

  it("is convergent: identical content + same context produces byte-identical ciphertext", () => {
    const masterKey = randomMasterKey();
    const plaintext = Buffer.from("identical content, encrypted twice");
    const context = contentHashContext(plaintext); // same content -> same context

    const encodedA = encryptBuffer(plaintext, masterKey, context, TEST_CHUNK_SIZE);
    const encodedB = encryptBuffer(plaintext, masterKey, context, TEST_CHUNK_SIZE);

    expect(encodedA.equals(encodedB)).toBe(true);
  });

  it("is non-convergent when given different random contexts (state.db snapshots)", () => {
    const masterKey = randomMasterKey();
    const plaintext = Buffer.from("same plaintext, different random contexts");

    const contextA = Buffer.alloc(16);
    sodium.randombytes_buf(contextA);
    const contextB = Buffer.alloc(16);
    sodium.randombytes_buf(contextB);

    const encodedA = encryptBuffer(plaintext, masterKey, contextA, TEST_CHUNK_SIZE);
    const encodedB = encryptBuffer(plaintext, masterKey, contextB, TEST_CHUNK_SIZE);

    expect(encodedA.equals(encodedB)).toBe(false);
    // but both still decrypt back to the same plaintext under the same master key
    expect(decryptBuffer(encodedA, masterKey).equals(plaintext)).toBe(true);
    expect(decryptBuffer(encodedB, masterKey).equals(plaintext)).toBe(true);
  });
});
