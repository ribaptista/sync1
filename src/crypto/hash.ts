import sodium from "sodium-native";

export const HASH_ALGORITHM = "blake2b";
export const HASH_BYTES = 32;

export function hashBufferHex(data: Buffer): string {
  const out = Buffer.alloc(HASH_BYTES);
  sodium.crypto_generichash(out, data);
  return out.toString("hex");
}

/** Streaming BLAKE2b, for hashing large files without buffering them fully. */
export class StreamingHasher {
  private readonly state: Buffer;

  constructor() {
    this.state = Buffer.alloc(sodium.crypto_generichash_STATEBYTES);
    sodium.crypto_generichash_init(this.state, null, HASH_BYTES);
  }

  update(chunk: Buffer): void {
    sodium.crypto_generichash_update(this.state, chunk);
  }

  digestHex(): string {
    const out = Buffer.alloc(HASH_BYTES);
    sodium.crypto_generichash_final(this.state, out);
    return out.toString("hex");
  }
}

const HEX_64_RE = /^[0-9a-f]{64}$/;

export function isValidHashHex(hex: string): boolean {
  return HEX_64_RE.test(hex);
}

/** The self-describing hash string a stub file's content holds, e.g. "blake2b:<hex>". */
export function formatTaggedHash(hex: string): string {
  return `${HASH_ALGORITHM}:${hex}`;
}

export interface TaggedHash {
  algorithm: string;
  hex: string;
}

export function parseTaggedHash(tagged: string): TaggedHash | null {
  const idx = tagged.indexOf(":");
  if (idx === -1) return null;
  return { algorithm: tagged.slice(0, idx), hex: tagged.slice(idx + 1) };
}
