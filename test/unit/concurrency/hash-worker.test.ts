import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import hashFileTask, { checksumFileTask } from "../../../src/concurrency/hash-worker.js";
import { hashFile } from "../../../src/fs/hash-file.js";
import { encryptFileForObject } from "../../../src/fs/encrypt-file.js";
import { hashBufferHex } from "../../../src/crypto/hash.js";

// This test calls the worker's exported function directly, in-thread -- never
// through a real Piscina pool, which would be slow and would defeat the
// purpose of a fast unit suite (see the plan's hash-worker design notes).
describe("hash-worker's default export", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the same hash as hashFile for a given path", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-hash-worker-"));
    const filePath = path.join(tmpDir, "content.bin");
    fs.writeFileSync(filePath, "hello from a hash worker test");

    const [expected, actual] = await Promise.all([
      hashFile(filePath),
      hashFileTask({ absolutePath: filePath }),
    ]);
    expect(actual).toBe(expected);
  });

  it("propagates a real I/O error for a missing file", async () => {
    await expect(
      hashFileTask({ absolutePath: "/nonexistent/path/does-not-exist.bin" }),
    ).rejects.toThrow();
  });

  it("leaves the shared counter at the file's exact size when given one", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-hash-worker-"));
    const filePath = path.join(tmpDir, "content.bin");
    // Comfortably more than one read chunk (64KiB by default), so the
    // counter is genuinely accumulated across several callbacks rather than
    // set once -- that accumulation is the part worth pinning down.
    const contents = Buffer.alloc(200_000, "x");
    fs.writeFileSync(filePath, contents);

    const progress = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
    const counter = new BigInt64Array(progress);

    await hashFileTask({ absolutePath: filePath, progress });

    expect(Atomics.load(counter, 0)).toBe(BigInt(contents.length));
  });

  it("hashes identically whether or not a progress buffer is supplied", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-hash-worker-"));
    const filePath = path.join(tmpDir, "content.bin");
    fs.writeFileSync(filePath, "progress reporting must not disturb the digest");

    const withoutProgress = await hashFileTask({ absolutePath: filePath });
    const withProgress = await hashFileTask({
      absolutePath: filePath,
      progress: new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT),
    });

    expect(withProgress).toBe(withoutProgress);
  });
});

// Same in-thread-call style as hashFileTask's own tests above -- never
// through a real Piscina pool.
describe("checksum-worker's checksumFileTask export", () => {
  let tmpDir: string;
  const masterKey = crypto.randomBytes(32);

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** What encryptFileForObject itself produces, run directly on the main thread. */
  async function mainThreadResult(
    filePath: string,
    size: number,
    hash: string,
  ): Promise<{ plaintextHash: string; ciphertextChecksum: string | null }> {
    const { ciphertext, result } = encryptFileForObject(filePath, size, masterKey, hash, {
      hashMismatch: "report",
      checksum: true,
    });
    ciphertext.resume();
    return result;
  }

  it("matches encryptFileForObject run on the main thread, for an unmodified file", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-checksum-worker-"));
    const content = Buffer.from("steady content, unedited since it was scanned");
    const filePath = path.join(tmpDir, "content.bin");
    fs.writeFileSync(filePath, content);
    const hash = hashBufferHex(content);

    const [expected, actual] = await Promise.all([
      mainThreadResult(filePath, content.length, hash),
      checksumFileTask({
        absolutePath: filePath,
        size: content.length,
        hash,
        masterKey: new Uint8Array(masterKey),
      }),
    ]);

    expect(actual).toEqual(expected);
    expect(actual.plaintextHash).toBe(hash);
    expect(actual.ciphertextChecksum).toEqual(expect.any(String));
  });

  it("reports the true hash of mismatched content, rather than throwing", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-checksum-worker-"));
    const scanned = hashBufferHex(Buffer.from("the content that was hashed at scan time.."));
    const actualContent = Buffer.from("the content that is on disk at upload time");
    const filePath = path.join(tmpDir, "content.bin");
    fs.writeFileSync(filePath, actualContent);

    const result = await checksumFileTask({
      absolutePath: filePath,
      size: actualContent.length,
      hash: scanned,
      masterKey: new Uint8Array(masterKey),
    });

    expect(result.plaintextHash).toBe(hashBufferHex(actualContent));
    expect(result.plaintextHash).not.toBe(scanned);
    expect(result.ciphertextChecksum).toEqual(expect.any(String));
  });

  it("propagates a real I/O error for a missing file", async () => {
    await expect(
      checksumFileTask({
        absolutePath: "/nonexistent/path/does-not-exist.bin",
        size: 3,
        hash: "a".repeat(64),
        masterKey: new Uint8Array(masterKey),
      }),
    ).rejects.toThrow(/ENOENT/);
  });

  it("leaves the shared counter at the file's exact size when given one", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-checksum-worker-"));
    const content = Buffer.alloc(200_000, "x");
    const filePath = path.join(tmpDir, "content.bin");
    fs.writeFileSync(filePath, content);
    const hash = hashBufferHex(content);

    const progress = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
    const counter = new BigInt64Array(progress);

    await checksumFileTask({
      absolutePath: filePath,
      size: content.length,
      hash,
      masterKey: new Uint8Array(masterKey),
      progress,
    });

    expect(Atomics.load(counter, 0)).toBe(BigInt(content.length));
  });
});
