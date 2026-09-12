import sodium from "sodium-native";

export const KDF_ALGORITHM = "argon2id";
export const MASTER_KEY_BYTES = 32;

export interface KdfParams {
  /** hex-encoded salt, crypto_pwhash_SALTBYTES long */
  salt: string;
  opslimit: number;
  memlimit: number;
}

/**
 * MODERATE cost (~250-450ms, 256MiB) rather than INTERACTIVE: this KDF runs
 * at most a handful of times per CLI invocation (the master key is reused
 * for the process lifetime once derived), not in a hot loop, so it's worth
 * paying for meaningfully better resistance against offline cracking of
 * what may be years of irreplaceable backed-up photos/videos.
 */
export function defaultKdfCost(): { opslimit: number; memlimit: number } {
  return {
    opslimit: sodium.crypto_pwhash_OPSLIMIT_MODERATE,
    memlimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE,
  };
}

export function generateSalt(): Buffer {
  const salt = Buffer.alloc(sodium.crypto_pwhash_SALTBYTES);
  sodium.randombytes_buf(salt);
  return salt;
}

export function deriveMasterKey(password: string, params: KdfParams): Buffer {
  const salt = Buffer.from(params.salt, "hex");
  if (salt.length !== sodium.crypto_pwhash_SALTBYTES) {
    throw new Error(
      `invalid KDF salt length: expected ${sodium.crypto_pwhash_SALTBYTES} bytes, got ${salt.length}`,
    );
  }
  const passwordBuf = Buffer.from(password, "utf8");
  const out = Buffer.alloc(MASTER_KEY_BYTES);
  sodium.crypto_pwhash(
    out,
    passwordBuf,
    salt,
    params.opslimit,
    params.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  return out;
}
