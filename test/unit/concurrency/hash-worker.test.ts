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

    const [expected, actual] = await Promise.all([hashFile(filePath), hashFileTask(filePath)]);
    expect(actual).toBe(expected);
  });

  it("propagates a real I/O error for a missing file", async () => {
    await expect(hashFileTask("/nonexistent/path/does-not-exist.bin")).rejects.toThrow();
  });
});
