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

  /**
   * A zero-byte plaintext never enters the chunk loop, so nothing would
   * otherwise ever touch `sourceStream` at all. For a real
   * `fs.createReadStream`, its `open()` is issued asynchronously and left
   * untouched would still be in flight when this generator returns -- if
   * the underlying file is removed (a test's own cleanup, in practice)
   * before that queued open() actually fires, it errors with no listener
   * attached, an unhandled rejection unrelated to anything this generator's
   * own caller awaited. Destroying the source explicitly, the same as the
   * aborted-signal branch does, is what retires it deterministically
   * instead of leaving its fate to GC and scheduling luck.
   */
  it("destroys an otherwise-untouched source stream for a zero-byte plaintext", async () => {
    const masterKey = randomMasterKey();
    const context = contentHashContext(Buffer.alloc(0));
    const source = chunkyReadable(Buffer.alloc(0), 4);

    await collect(encryptStream(source, 0, masterKey, context, { chunkSize: TEST_CHUNK_SIZE }));

    expect(source.destroyed).toBe(true);
  });

  /**
   * The actual mechanism, tested directly rather than through a real,
   * timing-dependent `fs` race: Node's rule is that an EventEmitter with
   * no 'error' listeners throws synchronously when 'error' is emitted on
   * it -- for a real stream, that becomes a process-crashing unhandled
   * 'error' event. `encryptStream` abandoning a source it never finished
   * with (zero bytes, or a mid-read abort) has to leave a listener behind,
   * not just call `.destroy()`, because a real `fs.createReadStream`'s
   * `open()` is issued asynchronously and can still fail (ENOENT, if the
   * file was removed meanwhile) well after `.destroy()` was already
   * called -- confirmed directly against a real `fs.createReadStream`,
   * not assumed from documentation.
   */
  it("leaves the abandoned zero-byte source listening for 'error', so a later one can't crash the process", async () => {
    const masterKey = randomMasterKey();
    const context = contentHashContext(Buffer.alloc(0));
    const source = chunkyReadable(Buffer.alloc(0), 4);

    await collect(encryptStream(source, 0, masterKey, context, { chunkSize: TEST_CHUNK_SIZE }));

    expect(() => source.emit("error", new Error("ENOENT (simulated)"))).not.toThrow();
  });

  it("destroys the source, with an 'error' listener attached, when the signal aborts mid-read", async () => {
    const masterKey = randomMasterKey();
    const plaintext = Buffer.from("content long enough to span a couple of chunks here");
    const context = contentHashContext(plaintext);
    const source = chunkyReadable(plaintext, 5);
    const controller = new AbortController();
    controller.abort();

    await expect(
      collect(
        encryptStream(source, plaintext.length, masterKey, context, {
          chunkSize: TEST_CHUNK_SIZE,
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow();

    expect(source.destroyed).toBe(true);
    expect(() => source.emit("error", new Error("ENOENT (simulated)"))).not.toThrow();
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

  describe("encryptStream: onPlaintextHash", () => {
    const masterKey = randomMasterKey();

    it("reports the actual plaintext hash without throwing, when given alone", async () => {
      const plaintext = Buffer.from("some content, reported but never asserted against");
      const context = contentHashContext(plaintext);
      let reported: string | undefined;

      const encoded = await collect(
        encryptStream(chunkyReadable(plaintext, 5), plaintext.length, masterKey, context, {
          chunkSize: TEST_CHUNK_SIZE,
          onPlaintextHash: (hex) => (reported = hex),
        }),
      );

      expect(reported).toBe(contentHashContext(plaintext).toString("hex"));
      // Not an assertion seam: the full ciphertext is still emitted even
      // though nothing here claimed to expect that particular hash.
      const whole = encryptBuffer(plaintext, masterKey, context, TEST_CHUNK_SIZE);
      expect(encoded.equals(whole)).toBe(true);
    });

    it("reports the true hash of mismatched content, rather than throwing", async () => {
      const scanned = Buffer.from("the content that was hashed at scan time..");
      const actual = Buffer.from("the content that is on disk at upload time");
      const context = contentHashContext(scanned);
      let reported: string | undefined;

      const encoded = await collect(
        encryptStream(chunkyReadable(actual, 5), actual.length, masterKey, context, {
          chunkSize: TEST_CHUNK_SIZE,
          onPlaintextHash: (hex) => (reported = hex),
        }),
      );

      // The reported hash is the content actually read, not `context`.
      expect(reported).toBe(contentHashContext(actual).toString("hex"));
      expect(reported).not.toBe(context.toString("hex"));
      // The stream still completes -- the caller asked to be told, not guarded.
      const whole = encryptBuffer(actual, masterKey, context, TEST_CHUNK_SIZE);
      expect(encoded.equals(whole)).toBe(true);
    });

    it("fires for a zero-byte plaintext too, immediately", async () => {
      const context = contentHashContext(Buffer.from("irrelevant"));
      let reported: string | undefined;

      await collect(
        encryptStream(chunkyReadable(Buffer.alloc(0), 4), 0, masterKey, context, {
          chunkSize: TEST_CHUNK_SIZE,
          onPlaintextHash: (hex) => (reported = hex),
        }),
      );

      expect(reported).toBe(contentHashContext(Buffer.alloc(0)).toString("hex"));
    });

    it("never fires when expectedHash rejects the content first", async () => {
      const scanned = Buffer.from("the content that was hashed at scan time..");
      const actual = Buffer.from("the content that is on disk at upload time");
      const context = contentHashContext(scanned);
      let reported: string | undefined;

      const stream = encryptStream(chunkyReadable(actual, 5), actual.length, masterKey, context, {
        chunkSize: TEST_CHUNK_SIZE,
        expectedHash: context.toString("hex"),
        onPlaintextHash: (hex) => (reported = hex),
      });

      await expect(collect(stream)).rejects.toThrow(/does not match the expected/);
      expect(reported).toBeUndefined();
    });

    it("fires exactly once, after expectedHash's own assertion passes", async () => {
      const plaintext = Buffer.from("content that is exactly what it claims to be");
      const context = contentHashContext(plaintext);
      let calls = 0;
      let reported: string | undefined;

      await collect(
        encryptStream(chunkyReadable(plaintext, 5), plaintext.length, masterKey, context, {
          chunkSize: TEST_CHUNK_SIZE,
          expectedHash: context.toString("hex"),
          onPlaintextHash: (hex) => {
            calls++;
            reported = hex;
          },
        }),
      );

      expect(calls).toBe(1);
      expect(reported).toBe(context.toString("hex"));
    });
  });
});
