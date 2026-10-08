import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { localCiphertextChecksum } from "../../../src/fs/ciphertext-checksum.js";
import { encryptStream } from "../../../src/crypto/streaming-codec.js";
import { UploadChecksumTap } from "../../../src/s3/checksum.js";
import { hashBufferHex } from "../../../src/crypto/hash.js";
import { DEFAULT_CHUNK_SIZE } from "../../../src/crypto/chunked-codec.js";

let dir: string;
const masterKey = crypto.randomBytes(32);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-ciphertext-checksum-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The checksum an upload records: the same codec, through the same tap. */
async function uploadChecksum(content: Buffer): Promise<string> {
  const tap = new UploadChecksumTap();
  const hash = hashBufferHex(content);
  const source = fs.createReadStream(writeFile("upload-source", content));
  const encrypted = encryptStream(source, content.length, masterKey, Buffer.from(hash, "hex"));
  const sink = new Writable({ write: (_chunk, _enc, cb) => cb() });
  await pipeline(tap.tap(encrypted), sink);
  return tap.checksum();
}

function writeFile(name: string, content: Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe("localCiphertextChecksum", () => {
  for (const [label, size] of [
    ["an empty file", 0],
    ["a small file", 1234],
    ["a file spanning several chunks", DEFAULT_CHUNK_SIZE * 2 + 17],
  ] as const) {
    it(`matches the checksum an upload records, for ${label}`, async () => {
      const content = crypto.randomBytes(size);
      const file = writeFile("f", content);
      let bytes = 0;

      const result = await localCiphertextChecksum(
        file,
        hashBufferHex(content),
        size,
        masterKey,
        (n) => (bytes += n),
      );

      expect(result).toEqual({ checksum: await uploadChecksum(content) });
      expect(bytes).toBe(size);
    });
  }

  it("differs under a different master key", async () => {
    const content = Buffer.from("same plaintext");
    const file = writeFile("f", content);
    const result = await localCiphertextChecksum(
      file,
      hashBufferHex(content),
      content.length,
      crypto.randomBytes(32),
    );
    expect(result).not.toEqual({ checksum: await uploadChecksum(content) });
  });

  it("returns an error, not a checksum, when the content doesn't hash to the expected hash", async () => {
    const file = writeFile("f", Buffer.from("tampered"));
    const result = await localCiphertextChecksum(
      file,
      hashBufferHex(Buffer.from("original")),
      8,
      masterKey,
    );
    expect(result).toMatchObject({ error: expect.stringMatching(/does not match the expected/) });
  });

  it("returns an error when the file's size differs from the recorded one", async () => {
    const content = Buffer.from("short");
    const file = writeFile("f", content);
    const result = await localCiphertextChecksum(file, hashBufferHex(content), 50, masterKey);
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("returns an error when the file can't be read", async () => {
    const result = await localCiphertextChecksum(
      path.join(dir, "missing"),
      "a".repeat(64),
      3,
      masterKey,
    );
    expect(result).toMatchObject({ error: expect.stringMatching(/ENOENT/) });
  });
});
