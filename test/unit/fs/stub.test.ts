import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readStubHash,
  writeStubAtomic,
  StubFormatError,
  fitsWithStubSuffix,
} from "../../../src/fs/stub.js";

const tempDirs: string[] = [];
function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-stub-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const HASH = "a".repeat(64);

describe("stub read/write", () => {
  it("round-trips a valid stub", () => {
    const dir = mkTempDir();
    const stubPath = path.join(dir, "img.jpg.stub");
    writeStubAtomic(stubPath, HASH);
    expect(readStubHash(stubPath)).toBe(HASH);
    expect(fs.readFileSync(stubPath, "utf8")).toBe(`blake2b:${HASH}`);
  });

  it("is never zero-byte", () => {
    const dir = mkTempDir();
    const stubPath = path.join(dir, "img.jpg.stub");
    writeStubAtomic(stubPath, HASH);
    expect(fs.statSync(stubPath).size).toBeGreaterThan(0);
  });

  it("rejects malformed content (no algorithm tag)", () => {
    const dir = mkTempDir();
    const stubPath = path.join(dir, "bad.stub");
    fs.writeFileSync(stubPath, HASH); // missing "blake2b:" prefix
    expect(() => readStubHash(stubPath)).toThrow(StubFormatError);
  });

  it("rejects malformed content (wrong algorithm tag)", () => {
    const dir = mkTempDir();
    const stubPath = path.join(dir, "bad.stub");
    fs.writeFileSync(stubPath, `sha256:${HASH}`);
    expect(() => readStubHash(stubPath)).toThrow(StubFormatError);
  });

  it("rejects malformed content (invalid hex)", () => {
    const dir = mkTempDir();
    const stubPath = path.join(dir, "bad.stub");
    fs.writeFileSync(stubPath, "blake2b:not-hex-at-all");
    expect(() => readStubHash(stubPath)).toThrow(StubFormatError);
  });

  it("rejects malformed content (empty file)", () => {
    const dir = mkTempDir();
    const stubPath = path.join(dir, "empty.stub");
    fs.writeFileSync(stubPath, "");
    expect(() => readStubHash(stubPath)).toThrow(StubFormatError);
  });
});

describe("fitsWithStubSuffix", () => {
  it("accepts a 250-byte basename (leaves exactly room for '.stub')", () => {
    expect(fitsWithStubSuffix("a".repeat(250))).toBe(true);
  });

  it("rejects a 251-byte basename", () => {
    expect(fitsWithStubSuffix("a".repeat(251))).toBe(false);
  });

  it("counts UTF-8 bytes, not characters", () => {
    // Each "é" is 2 bytes in UTF-8, so 126 of them is 252 bytes -- over the
    // limit even though the string is only 126 characters long.
    const basename = "é".repeat(126);
    expect(basename.length).toBe(126);
    expect(Buffer.byteLength(basename)).toBe(252);
    expect(fitsWithStubSuffix(basename)).toBe(false);
  });
});
