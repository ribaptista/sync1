// sodium-native ships no TypeScript types (its README's examples are plain
// JS) and there's no @types package for it. This declares only the subset
// of the native API this project actually calls.
declare module "sodium-native" {
  function randombytes_buf(buffer: Buffer): void;

  // generichash (BLAKE2b)
  const crypto_generichash_BYTES: number;
  const crypto_generichash_BYTES_MAX: number;
  const crypto_generichash_KEYBYTES_MIN: number;
  const crypto_generichash_KEYBYTES_MAX: number;
  const crypto_generichash_STATEBYTES: number;
  function crypto_generichash(output: Buffer, input: Buffer, key?: Buffer | null): void;
  function crypto_generichash_init(state: Buffer, key: Buffer | null, outputLength: number): void;
  function crypto_generichash_update(state: Buffer, input: Buffer): void;
  function crypto_generichash_final(state: Buffer, output: Buffer): void;

  // pwhash (Argon2id)
  const crypto_pwhash_SALTBYTES: number;
  const crypto_pwhash_OPSLIMIT_MIN: number;
  const crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
  const crypto_pwhash_OPSLIMIT_MODERATE: number;
  const crypto_pwhash_OPSLIMIT_SENSITIVE: number;
  const crypto_pwhash_OPSLIMIT_MAX: number;
  const crypto_pwhash_MEMLIMIT_MIN: number;
  const crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
  const crypto_pwhash_MEMLIMIT_MODERATE: number;
  const crypto_pwhash_MEMLIMIT_SENSITIVE: number;
  const crypto_pwhash_MEMLIMIT_MAX: number;
  const crypto_pwhash_ALG_ARGON2ID13: number;
  const crypto_pwhash_ALG_ARGON2I13: number;
  const crypto_pwhash_ALG_DEFAULT: number;
  function crypto_pwhash(
    output: Buffer,
    password: Buffer,
    salt: Buffer,
    opslimit: number,
    memlimit: number,
    algorithm: number,
  ): void;

  // kdf (subkey derivation)
  const crypto_kdf_CONTEXTBYTES: number;
  const crypto_kdf_KEYBYTES: number;
  const crypto_kdf_BYTES_MIN: number;
  const crypto_kdf_BYTES_MAX: number;
  function crypto_kdf_derive_from_key(
    subkey: Buffer,
    subkeyId: number,
    context: Buffer,
    key: Buffer,
  ): void;

  // aead (xchacha20poly1305-ietf)
  const crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
  const crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
  const crypto_aead_xchacha20poly1305_ietf_ABYTES: number;
  const crypto_aead_xchacha20poly1305_ietf_NSECBYTES: number;
  function crypto_aead_xchacha20poly1305_ietf_encrypt(
    ciphertext: Buffer,
    message: Buffer,
    additionalData: Buffer | null,
    secretNonce: Buffer | null,
    publicNonce: Buffer,
    key: Buffer,
  ): void;
  function crypto_aead_xchacha20poly1305_ietf_decrypt(
    message: Buffer,
    secretNonce: Buffer | null,
    ciphertext: Buffer,
    additionalData: Buffer | null,
    publicNonce: Buffer,
    key: Buffer,
  ): number;

  const sodium: {
    randombytes_buf: typeof randombytes_buf;
    crypto_generichash_BYTES: typeof crypto_generichash_BYTES;
    crypto_generichash_BYTES_MAX: typeof crypto_generichash_BYTES_MAX;
    crypto_generichash_KEYBYTES_MIN: typeof crypto_generichash_KEYBYTES_MIN;
    crypto_generichash_KEYBYTES_MAX: typeof crypto_generichash_KEYBYTES_MAX;
    crypto_generichash_STATEBYTES: typeof crypto_generichash_STATEBYTES;
    crypto_generichash: typeof crypto_generichash;
    crypto_generichash_init: typeof crypto_generichash_init;
    crypto_generichash_update: typeof crypto_generichash_update;
    crypto_generichash_final: typeof crypto_generichash_final;
    crypto_pwhash_SALTBYTES: typeof crypto_pwhash_SALTBYTES;
    crypto_pwhash_OPSLIMIT_MIN: typeof crypto_pwhash_OPSLIMIT_MIN;
    crypto_pwhash_OPSLIMIT_INTERACTIVE: typeof crypto_pwhash_OPSLIMIT_INTERACTIVE;
    crypto_pwhash_OPSLIMIT_MODERATE: typeof crypto_pwhash_OPSLIMIT_MODERATE;
    crypto_pwhash_OPSLIMIT_SENSITIVE: typeof crypto_pwhash_OPSLIMIT_SENSITIVE;
    crypto_pwhash_OPSLIMIT_MAX: typeof crypto_pwhash_OPSLIMIT_MAX;
    crypto_pwhash_MEMLIMIT_MIN: typeof crypto_pwhash_MEMLIMIT_MIN;
    crypto_pwhash_MEMLIMIT_INTERACTIVE: typeof crypto_pwhash_MEMLIMIT_INTERACTIVE;
    crypto_pwhash_MEMLIMIT_MODERATE: typeof crypto_pwhash_MEMLIMIT_MODERATE;
    crypto_pwhash_MEMLIMIT_SENSITIVE: typeof crypto_pwhash_MEMLIMIT_SENSITIVE;
    crypto_pwhash_MEMLIMIT_MAX: typeof crypto_pwhash_MEMLIMIT_MAX;
    crypto_pwhash_ALG_ARGON2ID13: typeof crypto_pwhash_ALG_ARGON2ID13;
    crypto_pwhash_ALG_ARGON2I13: typeof crypto_pwhash_ALG_ARGON2I13;
    crypto_pwhash_ALG_DEFAULT: typeof crypto_pwhash_ALG_DEFAULT;
    crypto_pwhash: typeof crypto_pwhash;
    crypto_kdf_CONTEXTBYTES: typeof crypto_kdf_CONTEXTBYTES;
    crypto_kdf_KEYBYTES: typeof crypto_kdf_KEYBYTES;
    crypto_kdf_BYTES_MIN: typeof crypto_kdf_BYTES_MIN;
    crypto_kdf_BYTES_MAX: typeof crypto_kdf_BYTES_MAX;
    crypto_kdf_derive_from_key: typeof crypto_kdf_derive_from_key;
    crypto_aead_xchacha20poly1305_ietf_KEYBYTES: typeof crypto_aead_xchacha20poly1305_ietf_KEYBYTES;
    crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: typeof crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    crypto_aead_xchacha20poly1305_ietf_ABYTES: typeof crypto_aead_xchacha20poly1305_ietf_ABYTES;
    crypto_aead_xchacha20poly1305_ietf_NSECBYTES: typeof crypto_aead_xchacha20poly1305_ietf_NSECBYTES;
    crypto_aead_xchacha20poly1305_ietf_encrypt: typeof crypto_aead_xchacha20poly1305_ietf_encrypt;
    crypto_aead_xchacha20poly1305_ietf_decrypt: typeof crypto_aead_xchacha20poly1305_ietf_decrypt;
  };

  export = sodium;
}
