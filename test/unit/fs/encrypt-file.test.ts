import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { encryptFileForObject } from "../../../src/fs/encrypt-file.js";
import { encryptStream, decryptStream } from "../../../src/crypto/streaming-codec.js";
import { UploadChecksumTap } from "../../../src/s3/checksum.js";
import { hashBufferHex } from "../../../src/crypto/hash.js";
import { DEFAULT_CHUNK_SIZE } from "../../../src/crypto/chunked-codec.js";

let dir: string;
const masterKey = crypto.randomBytes(32);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-encrypt-file-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(name: string, content: Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

/** The ciphertext (and its checksum) an upload or mirror re-encrypt would independently produce. */
async function referenceEncryption(
  content: Buffer,
  hash: string,
): Promise<{ ciphertext: Buffer; checksum: string }> {
  const tap = new UploadChecksumTap();
  const encrypted = encryptStream(
    fs.createReadStream(writeFile("reference-source", content)),
    content.length,
    masterKey,
    Buffer.from(hash, "hex"),
  );
  const tapped = tap.tap(encrypted);
  const ciphertext = await collect(tapped);
  return { ciphertext, checksum: await tap.checksum() };
}

describe("encryptFileForObject", () => {
  for (const [label, size] of [
    ["an empty file", 0],
    ["a small file", 1234],
    ["a file spanning several chunks", DEFAULT_CHUNK_SIZE * 2 + 17],
  ] as const) {
    it(`"report" mode: matches a reference encryption and reports the real hash, for ${label}`, async () => {
      const content = crypto.randomBytes(size);
      const hash = hashBufferHex(content);
      const file = writeFile("f", content);
      let bytes = 0;

      const { ciphertext, result } = encryptFileForObject(file, size, masterKey, hash, {
        onBytes: (n) => (bytes += n),
        hashMismatch: "report",
        checksum: true,
      });
      const produced = await collect(ciphertext);
      const { plaintextHash, ciphertextChecksum } = await result;

      const reference = await referenceEncryption(content, hash);
      expect(produced.equals(reference.ciphertext)).toBe(true);
      expect(ciphertextChecksum).toBe(reference.checksum);
      expect(plaintextHash).toBe(hash);
      expect(bytes).toBe(size);

      // And it genuinely decrypts back to the original content.
      const decrypted = await collect(decryptStream(Readable.from([produced]), masterKey));
      expect(decrypted.equals(content)).toBe(true);
    });
  }

  it('"report" mode reports the true hash of mismatched content, and still completes', async () => {
    const scanned = hashBufferHex(Buffer.from("the content that was hashed at scan time.."));
    const actual = Buffer.from("the content that is on disk at upload time");
    const file = writeFile("f", actual);

    const { ciphertext, result } = encryptFileForObject(file, actual.length, masterKey, scanned, {
      hashMismatch: "report",
      checksum: true,
    });
    await collect(ciphertext);
    const { plaintextHash, ciphertextChecksum } = await result;

    expect(plaintextHash).toBe(hashBufferHex(actual));
    expect(plaintextHash).not.toBe(scanned);
    expect(ciphertextChecksum).toEqual(expect.any(String));
  });

  it('"abort" mode rejects on a hash mismatch, and `result` reflects the same rejection', async () => {
    const scanned = hashBufferHex(Buffer.from("the content that was hashed at scan time.."));
    const actual = Buffer.from("the content that is on disk at upload time");
    const file = writeFile("f", actual);

    const { ciphertext, result } = encryptFileForObject(file, actual.length, masterKey, scanned, {
      hashMismatch: "abort",
      checksum: false,
    });

    await expect(collect(ciphertext)).rejects.toThrow(/does not match the expected/);
    await expect(result).rejects.toThrow(/does not match the expected/);
  });

  it('"abort" mode reports plaintextHash as `hash` itself on success, without a checksum when not requested', async () => {
    const content = Buffer.from("steady content, unedited since it was scanned");
    const hash = hashBufferHex(content);
    const file = writeFile("f", content);

    const { ciphertext, result } = encryptFileForObject(file, content.length, masterKey, hash, {
      hashMismatch: "abort",
      checksum: false,
    });
    await collect(ciphertext);
    const { plaintextHash, ciphertextChecksum } = await result;

    expect(plaintextHash).toBe(hash);
    expect(ciphertextChecksum).toBeNull();
  });

  it("rejects when the file can't be read, through both ciphertext and result", async () => {
    const { ciphertext, result } = encryptFileForObject(
      path.join(dir, "missing"),
      3,
      masterKey,
      "a".repeat(64),
      { hashMismatch: "report", checksum: true },
    );
    await expect(collect(ciphertext)).rejects.toThrow(/ENOENT/);
    await expect(result).rejects.toThrow(/ENOENT/);
  });

  it("rejects when the given size disagrees with the file's actual size", async () => {
    const content = Buffer.from("short");
    const hash = hashBufferHex(content);
    const file = writeFile("f", content);

    const { ciphertext, result } = encryptFileForObject(file, 50, masterKey, hash, {
      hashMismatch: "report",
      checksum: true,
    });
    await expect(collect(ciphertext)).rejects.toThrow(/source file changed size/);
    await expect(result).rejects.toThrow(/source file changed size/);
  });

  it("produces a different ciphertext checksum under a different master key", async () => {
    const content = Buffer.from("same plaintext, different vault");
    const hash = hashBufferHex(content);
    const file = writeFile("f", content);

    const { ciphertext, result } = encryptFileForObject(file, content.length, masterKey, hash, {
      hashMismatch: "report",
      checksum: true,
    });
    await collect(ciphertext);
    const { ciphertextChecksum } = await result;

    const reference = await referenceEncryption(content, hash);
    const otherKeyFile = writeFile("g", content);
    const otherTap = new UploadChecksumTap();
    const otherEncrypted = encryptStream(
      fs.createReadStream(otherKeyFile),
      content.length,
      crypto.randomBytes(32),
      Buffer.from(hash, "hex"),
    );
    await pipeline(otherTap.tap(otherEncrypted), new Writable({ write: (_c, _e, cb) => cb() }));

    expect(ciphertextChecksum).toBe(reference.checksum);
    expect(await otherTap.checksum()).not.toBe(reference.checksum);
  });
});
