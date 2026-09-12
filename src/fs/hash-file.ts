import fs from "node:fs";
import { StreamingHasher } from "../crypto/hash.js";

/** Streams a file through BLAKE2b rather than buffering it fully — files here can be multi-GB video. */
export async function hashFile(absolutePath: string): Promise<string> {
  const hasher = new StreamingHasher();
  const stream = fs.createReadStream(absolutePath);
  for await (const chunk of stream) {
    hasher.update(chunk as Buffer);
  }
  return hasher.digestHex();
}
