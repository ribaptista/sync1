import sodium from "sodium-native";

const CONTEXT_BYTES = sodium.crypto_kdf_CONTEXTBYTES;

/**
 * Deterministic subkey derivation from a fixed-length key. `context` must be
 * exactly `crypto_kdf_CONTEXTBYTES` (8) bytes — it's meant for a short fixed
 * label, not arbitrary data (that's what `deriveObjectKey` in
 * chunked-codec.ts is for, via a keyed hash instead).
 */
export function deriveSubkey(
  key: Buffer,
  subkeyId: number,
  context: string,
  outputLength: number,
): Buffer {
  const contextBuf = Buffer.from(context, "ascii");
  if (contextBuf.length !== CONTEXT_BYTES) {
    throw new Error(
      `kdf context must be exactly ${CONTEXT_BYTES} bytes, got "${context}" (${contextBuf.length} bytes)`,
    );
  }
  const out = Buffer.alloc(outputLength);
  sodium.crypto_kdf_derive_from_key(out, subkeyId, contextBuf, key);
  return out;
}
