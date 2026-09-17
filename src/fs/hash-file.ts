import fs from "node:fs";
import { StreamingHasher } from "../crypto/hash.js";

/**
 * Streams a file through BLAKE2b rather than buffering it fully — files here
 * can be multi-GB video.
 *
 * `onBytes`, when given, is called once per chunk with its length, so a
 * caller can report progress through a file far larger than any single
 * hash takes to feel instant. Note this runs inside a worker thread in
 * production (see src/concurrency/hash-worker.ts), so the callback there
 * writes to shared memory rather than touching the progress bar directly.
 */
export async function hashFile(
  absolutePath: string,
  onBytes?: (n: number) => void,
): Promise<string> {
  const hasher = new StreamingHasher();
  const stream = fs.createReadStream(absolutePath);
  for await (const chunk of stream) {
    hasher.update(chunk as Buffer);
    onBytes?.((chunk as Buffer).length);
  }
  return hasher.digestHex();
}
