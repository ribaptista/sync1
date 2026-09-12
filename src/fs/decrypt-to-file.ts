import fs from "node:fs";
import type { Readable } from "node:stream";
import { decryptStream } from "../crypto/streaming-codec.js";
import { StreamingHasher } from "../crypto/hash.js";

/**
 * Decrypts an encoded object stream directly to `destPath`, hashing the
 * plaintext incrementally (never holding the whole file in memory) and
 * returning the resulting hash for the caller to verify against the
 * recorded content hash before treating the write as trustworthy.
 */
export async function decryptStreamToFile(
  sourceStream: Readable,
  masterKey: Buffer,
  destPath: string,
): Promise<string> {
  const hasher = new StreamingHasher();
  const writeStream = fs.createWriteStream(destPath);
  const decrypted = decryptStream(sourceStream, masterKey);

  for await (const chunk of decrypted) {
    hasher.update(chunk);
    if (!writeStream.write(chunk)) {
      await new Promise<void>((resolve) => writeStream.once("drain", resolve));
    }
  }

  await new Promise<void>((resolve, reject) => {
    writeStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });

  return hasher.digestHex();
}
