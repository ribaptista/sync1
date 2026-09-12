import fs from "node:fs";
import { randomBytes } from "node:crypto";
import {
  formatTaggedHash,
  parseTaggedHash,
  isValidHashHex,
  HASH_ALGORITHM,
} from "../crypto/hash.js";

export function stubPathFor(realAbsolutePath: string): string {
  return `${realAbsolutePath}.stub`;
}

export class StubFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StubFormatError";
  }
}

/**
 * Reads and validates a stub file's content, returning the hex hash it
 * declares. A stub is never zero-byte -- its content is a self-describing,
 * algorithm-tagged hash string (e.g. "blake2b:<hex>"), which is what lets
 * update_cache validate a stub without ever needing to hash its (empty of
 * real content) bytes.
 */
export function readStubHash(absoluteStubPath: string): string {
  const content = fs.readFileSync(absoluteStubPath, "utf8").trim();
  const parsed = parseTaggedHash(content);
  if (!parsed || parsed.algorithm !== HASH_ALGORITHM || !isValidHashHex(parsed.hex)) {
    throw new StubFormatError(`malformed stub content: "${content}"`);
  }
  return parsed.hex;
}

/** Writes a stub file atomically (tmp + rename) so a crash never leaves a half-written stub. */
export function writeStubAtomic(absoluteStubPath: string, hashHex: string): void {
  const tmpPath = `${absoluteStubPath}.sync1-tmp-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmpPath, formatTaggedHash(hashHex));
  fs.renameSync(tmpPath, absoluteStubPath);
}
