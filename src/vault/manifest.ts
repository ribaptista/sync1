import sodium from "sodium-native";
import {
  deriveMasterKey,
  generateSalt,
  defaultKdfCost,
  KDF_ALGORITHM,
  type KdfParams,
} from "../crypto/kdf.js";
import { encryptBuffer, decryptBuffer, CryptoAuthError } from "../crypto/chunked-codec.js";

export interface VaultManifest {
  version: 1;
  kdf: typeof KDF_ALGORITHM;
  kdf_params: KdfParams;
  /** hex-encoded chunked-codec output; decrypting it and checking the plaintext is the password check. */
  verifier: string;
  created_at: string;
}

const VERIFIER_PLAINTEXT = Buffer.from("sync1-vault-verifier-v1", "utf8");

export class InvalidPasswordError extends Error {
  constructor() {
    super("incorrect password for this vault");
    this.name = "InvalidPasswordError";
  }
}

/** Creates a brand-new vault manifest + derives its master key (init_remote). */
export function createVaultManifest(password: string): {
  manifest: VaultManifest;
  masterKey: Buffer;
} {
  const salt = generateSalt();
  const kdfParams: KdfParams = { salt: salt.toString("hex"), ...defaultKdfCost() };
  const masterKey = deriveMasterKey(password, kdfParams);

  const context = Buffer.alloc(16);
  sodium.randombytes_buf(context);
  const verifierEncoded = encryptBuffer(VERIFIER_PLAINTEXT, masterKey, context);

  const manifest: VaultManifest = {
    version: 1,
    kdf: KDF_ALGORITHM,
    kdf_params: kdfParams,
    verifier: verifierEncoded.toString("hex"),
    created_at: new Date().toISOString(),
  };
  return { manifest, masterKey };
}

/**
 * Derives the master key from a password against an existing manifest and
 * verifies it's correct before returning — callers never have to separately
 * "try" the key against real content and guess why it failed.
 */
export function unlockVault(manifest: VaultManifest, password: string): Buffer {
  const masterKey = deriveMasterKey(password, manifest.kdf_params);
  const verifierEncoded = Buffer.from(manifest.verifier, "hex");
  let plaintext: Buffer;
  try {
    plaintext = decryptBuffer(verifierEncoded, masterKey);
  } catch (err) {
    if (err instanceof CryptoAuthError) throw new InvalidPasswordError();
    throw err;
  }
  if (!plaintext.equals(VERIFIER_PLAINTEXT)) {
    throw new InvalidPasswordError();
  }
  return masterKey;
}

export function serializeManifest(manifest: VaultManifest): Buffer {
  return Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
}

export function parseManifest(data: Buffer): VaultManifest {
  const parsed: unknown = JSON.parse(data.toString("utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    (parsed as { kdf?: unknown }).kdf !== KDF_ALGORITHM ||
    typeof (parsed as { verifier?: unknown }).verifier !== "string" ||
    typeof (parsed as { kdf_params?: unknown }).kdf_params !== "object"
  ) {
    throw new Error("malformed vault.json: not a recognizable sync1 vault manifest");
  }
  return parsed as VaultManifest;
}
