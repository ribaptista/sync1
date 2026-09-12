import { describe, it, expect } from "vitest";
import {
  hashBufferHex,
  StreamingHasher,
  isValidHashHex,
  formatTaggedHash,
  parseTaggedHash,
} from "../../../src/crypto/hash.js";

describe("hash", () => {
  it("produces a 64-char hex digest", () => {
    const hex = hashBufferHex(Buffer.from("hello world"));
    expect(hex).toHaveLength(64);
    expect(isValidHashHex(hex)).toBe(true);
  });

  it("is deterministic for identical content", () => {
    const a = hashBufferHex(Buffer.from("same content"));
    const b = hashBufferHex(Buffer.from("same content"));
    expect(a).toBe(b);
  });

  it("differs for different content", () => {
    const a = hashBufferHex(Buffer.from("content A"));
    const b = hashBufferHex(Buffer.from("content B"));
    expect(a).not.toBe(b);
  });

  it("streaming hasher matches one-shot hash for the same content", () => {
    const content = Buffer.from("the quick brown fox jumps over the lazy dog");
    const oneShot = hashBufferHex(content);

    const hasher = new StreamingHasher();
    hasher.update(content.subarray(0, 10));
    hasher.update(content.subarray(10, 25));
    hasher.update(content.subarray(25));
    const streamed = hasher.digestHex();

    expect(streamed).toBe(oneShot);
  });

  it("streaming hasher matches one-shot hash for empty content", () => {
    const oneShot = hashBufferHex(Buffer.alloc(0));
    const hasher = new StreamingHasher();
    expect(hasher.digestHex()).toBe(oneShot);
  });

  it("rejects malformed hex", () => {
    expect(isValidHashHex("not-hex")).toBe(false);
    expect(isValidHashHex("abcd")).toBe(false); // too short
    expect(isValidHashHex("Z".repeat(64))).toBe(false); // not hex chars
  });

  it("formats and parses tagged hashes round-trip", () => {
    const hex = hashBufferHex(Buffer.from("stub content"));
    const tagged = formatTaggedHash(hex);
    expect(tagged).toBe(`blake2b:${hex}`);

    const parsed = parseTaggedHash(tagged);
    expect(parsed).toEqual({ algorithm: "blake2b", hex });
  });

  it("returns null when parsing an untagged string", () => {
    expect(parseTaggedHash("no-colon-here")).toBeNull();
  });
});
