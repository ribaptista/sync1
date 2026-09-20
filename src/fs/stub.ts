import fs from "node:fs";
import {
  formatTaggedHash,
  parseTaggedHash,
  isValidHashHex,
  HASH_ALGORITHM,
} from "../crypto/hash.js";
import { CorruptionError } from "../errors.js";
import { inTreeTempPath } from "./temp-path.js";

export function stubPathFor(realAbsolutePath: string): string {
  return `${realAbsolutePath}.stub`;
}

export class StubFormatError extends CorruptionError {
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
  const tmpPath = inTreeTempPath(absoluteStubPath);
  fs.writeFileSync(tmpPath, formatTaggedHash(hashHex));
  fs.renameSync(tmpPath, absoluteStubPath);
}
