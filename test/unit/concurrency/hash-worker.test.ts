import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import hashFileTask from "../../../src/concurrency/hash-worker.js";
import { hashFile } from "../../../src/fs/hash-file.js";

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
