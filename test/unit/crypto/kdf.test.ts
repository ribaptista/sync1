import { describe, it, expect } from "vitest";
import sodium from "sodium-native";
import {
  deriveMasterKey,
  generateSalt,
  MASTER_KEY_BYTES,
  type KdfParams,
} from "../../../src/crypto/kdf.js";

// Cheapest valid cost parameters — these tests check correctness/wiring,
// not real-world security, so they should stay fast.
const FAST_COST = {
  opslimit: sodium.crypto_pwhash_OPSLIMIT_MIN,
  memlimit: sodium.crypto_pwhash_MEMLIMIT_MIN,
};

function fastParams(salt: Buffer): KdfParams {
  return { salt: salt.toString("hex"), ...FAST_COST };
}

describe("kdf", () => {
  it("derives a key of the expected length", () => {
    const salt = generateSalt();
    const key = deriveMasterKey("correct horse battery staple", fastParams(salt));
    expect(key).toHaveLength(MASTER_KEY_BYTES);
  });

  it("is deterministic for the same password + salt + cost", () => {
    const salt = generateSalt();
    const params = fastParams(salt);
    const a = deriveMasterKey("my-password", params);
    const b = deriveMasterKey("my-password", params);
    expect(a.equals(b)).toBe(true);
  });

  it("produces different keys for different passwords", () => {
    const salt = generateSalt();
    const params = fastParams(salt);
    const a = deriveMasterKey("password-one", params);
    const b = deriveMasterKey("password-two", params);
    expect(a.equals(b)).toBe(false);
  });

  it("produces different keys for different salts", () => {
    const a = deriveMasterKey("same-password", fastParams(generateSalt()));
    const b = deriveMasterKey("same-password", fastParams(generateSalt()));
    expect(a.equals(b)).toBe(false);
  });

  it("generates salts of the expected length", () => {
    expect(generateSalt()).toHaveLength(sodium.crypto_pwhash_SALTBYTES);
  });

  it("rejects a malformed salt", () => {
    expect(() => deriveMasterKey("password", { salt: "deadbeef", ...FAST_COST })).toThrow(
      /invalid KDF salt length/,
    );
  });
});
