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
      encryptStream(chunkyReadable(plaintext, 3), plaintext.length, masterKey, context, {
        chunkSize: TEST_CHUNK_SIZE,
      }),
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
      encryptStream(chunkyReadable(plaintext, 7), plaintext.length, masterKey, context, {
        chunkSize: TEST_CHUNK_SIZE,
      }),
    );
    const decrypted = await collect(decryptStream(chunkyReadable(encoded, 9), masterKey));

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("round-trips an empty buffer", async () => {
    const masterKey = randomMasterKey();
    const plaintext = Buffer.alloc(0);
    const context = contentHashContext(plaintext);

    const encoded = await collect(
      encryptStream(chunkyReadable(plaintext, 4), 0, masterKey, context, {
        chunkSize: TEST_CHUNK_SIZE,
      }),
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

  /**
   * The guarantee these pin down is that a mismatch makes the object
   * *never exist remotely*, rather than existing briefly and being cleaned
   * up. That only holds because the check sits between the last
   * `readExact` and the last `yield`: the hash is complete, the final
   * ciphertext chunk is not yet emitted, so the body ends short of the
   * `encryptedSize` the caller declared as ContentLength and S3 discards
   * an incomplete PUT. Move the check anywhere else -- upstream, or after
   * the loop -- and the seam is gone.
   */
  describe("encryptStream: expectedHash", () => {
    const masterKey = randomMasterKey();

    it("streams normally when the plaintext hashes to expectedHash", async () => {
      const plaintext = Buffer.from("content that is exactly what it claims to be");
      const context = contentHashContext(plaintext);
      const withCheck = await collect(
        encryptStream(chunkyReadable(plaintext, 5), plaintext.length, masterKey, context, {
          chunkSize: TEST_CHUNK_SIZE,
          expectedHash: context.toString("hex"),
        }),
      );
      const withoutCheck = await collect(
        encryptStream(chunkyReadable(plaintext, 5), plaintext.length, masterKey, context, {
          chunkSize: TEST_CHUNK_SIZE,
        }),
      );
      // Byte-identical: the check observes, it never alters the output.
      expect(withCheck.equals(withoutCheck)).toBe(true);
    });

    it("errors the stream, short of the declared size, when the plaintext disagrees", async () => {
      // The silent case: the bytes changed but the length did not, so
      // ContentLength still matches and the ciphertext checksum both ends
      // compute still agree. Nothing but the plaintext hash can tell.
      const scanned = Buffer.from("the content that was hashed at scan time..");
      const actual = Buffer.from("the content that is on disk at upload time");
      expect(actual.length).toBe(scanned.length);

      const context = contentHashContext(scanned);
      const stream = encryptStream(chunkyReadable(actual, 5), actual.length, masterKey, context, {
        chunkSize: TEST_CHUNK_SIZE,
        expectedHash: context.toString("hex"),
      });

      const emitted: Buffer[] = [];
      await expect(
        (async () => {
          for await (const chunk of stream) emitted.push(chunk as Buffer);
        })(),
      ).rejects.toThrow(/does not match the expected/);

      // The property the whole abort depends on: fewer bytes reached the
      // consumer than the ContentLength the upload declared, so the
      // request cannot complete and S3 stores nothing.
      const declared = encryptedSize(actual.length, context.length, TEST_CHUNK_SIZE);
      expect(Buffer.concat(emitted).length).toBeLessThan(declared);
    });

    it("rejects a zero-byte plaintext before even the header escapes", async () => {
      // totalChunks is 0, so the loop never runs and the header alone is
      // the entire body -- checking after it were yielded would leave
      // nothing to withhold, and the upload would complete successfully.
      const context = contentHashContext(Buffer.from("not empty at scan time"));
      const stream = encryptStream(chunkyReadable(Buffer.alloc(0), 4), 0, masterKey, context, {
        chunkSize: TEST_CHUNK_SIZE,
        expectedHash: context.toString("hex"),
      });

      const emitted: Buffer[] = [];
      await expect(
        (async () => {
          for await (const chunk of stream) emitted.push(chunk as Buffer);
        })(),
      ).rejects.toThrow(/does not match the expected/);
      expect(Buffer.concat(emitted).length).toBe(0);
    });

    it("still catches a size change through readExact, with its own message", async () => {
      // The pre-existing half of the guard, kept honest: a shorter file
      // fails before the hash comparison is ever reached.
      const context = contentHashContext(Buffer.from("declared as longer than it is"));
      const stream = encryptStream(
        chunkyReadable(Buffer.from("short"), 5),
        40,
        masterKey,
        context,
        {
          chunkSize: TEST_CHUNK_SIZE,
          expectedHash: context.toString("hex"),
        },
      );
      await expect(collect(stream)).rejects.toThrow(/source file changed size during read/);
    });
  });
});
