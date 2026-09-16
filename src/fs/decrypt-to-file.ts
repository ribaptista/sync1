import fs from "node:fs";
import type { Readable } from "node:stream";
import { decryptStream } from "../crypto/streaming-codec.js";
import { StreamingHasher } from "../crypto/hash.js";

/**
 * Decrypts an encoded object stream directly to `destPath`, hashing the
 * plaintext incrementally (never holding the whole file in memory) and
 * returning the resulting hash for the caller to verify against the
 * recorded content hash before treating the write as trustworthy.
 *
 * `onBytes`, when given, is called once per plaintext chunk with its length.
 * This loop is the accurate place to hook download progress: `decrypted`
 * yields plaintext, and those chunks sum to exactly `objectRow.size` -- the
 * same denominator the caller's FileTracker was started with -- unlike the
 * encrypted wire bytes, which run larger and would desync the bar's fill
 * from its own stated total.
 */
export async function decryptStreamToFile(
  sourceStream: Readable,
  masterKey: Buffer,
  destPath: string,
  onBytes?: (n: number) => void,
): Promise<string> {
  const hasher = new StreamingHasher();
  const writeStream = fs.createWriteStream(destPath);
  const decrypted = decryptStream(sourceStream, masterKey);

  for await (const chunk of decrypted) {
    hasher.update(chunk);
    onBytes?.(chunk.length);
    if (!writeStream.write(chunk)) {
      await new Promise<void>((resolve) => writeStream.once("drain", resolve));
    }
  }

  await new Promise<void>((resolve, reject) => {
    writeStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });

  return hasher.digestHex();
}
