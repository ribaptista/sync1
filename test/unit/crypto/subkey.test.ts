import { describe, it, expect } from "vitest";
import sodium from "sodium-native";
import { deriveSubkey } from "../../../src/crypto/subkey.js";

function randomKey(): Buffer {
  const key = Buffer.alloc(sodium.crypto_kdf_KEYBYTES);
  sodium.randombytes_buf(key);
  return key;
}

describe("subkey derivation", () => {
  it("is deterministic for the same inputs", () => {
    const key = randomKey();
    const a = deriveSubkey(key, 0, "sy1obj01", 32);
    const b = deriveSubkey(key, 0, "sy1obj01", 32);
    expect(a.equals(b)).toBe(true);
  });

  it("differs across subkey ids (this is what gives each chunk its own key)", () => {
    const key = randomKey();
    const a = deriveSubkey(key, 0, "sy1obj01", 32);
    const b = deriveSubkey(key, 1, "sy1obj01", 32);
    expect(a.equals(b)).toBe(false);
  });

  it("differs across contexts", () => {
    const key = randomKey();
    const a = deriveSubkey(key, 0, "sy1obj01", 32);
    const b = deriveSubkey(key, 0, "sy1nonc1", 32);
    expect(a.equals(b)).toBe(false);
  });

  it("rejects a context that isn't exactly 8 bytes", () => {
    const key = randomKey();
    expect(() => deriveSubkey(key, 0, "short", 32)).toThrow(/exactly 8 bytes/);
    expect(() => deriveSubkey(key, 0, "toolongcontext", 32)).toThrow(/exactly 8 bytes/);
  });
});
