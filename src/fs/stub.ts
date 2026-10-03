import fs from "node:fs";
import {
  formatTaggedHash,
  parseTaggedHash,
  isValidHashHex,
  HASH_ALGORITHM,
} from "../crypto/hash.js";
import { CorruptionError } from "../errors.js";
import { inTreeTempPath } from "./temp-path.js";
import { durableRename } from "./durable.js";

/** Linux filesystems (ext4, btrfs, xfs, ...) cap a single path component at this many bytes. */
export const MAX_FILENAME_BYTES = 255;

export const STUB_SUFFIX = ".stub";

export function stubPathFor(realAbsolutePath: string): string {
  return `${realAbsolutePath}${STUB_SUFFIX}`;
}

/**
 * True when `basename` (the real file's own name) still fits under
 * `MAX_FILENAME_BYTES` once `STUB_SUFFIX` is appended -- the actual
 * constraint a trackable file's name has to satisfy, since every tracked
 * file can be stubbed at any time (by `stubify`, or by a pulling client
 * materializing it as a placeholder via `sync`). The single place this
 * budget is computed; nothing else should hardcode the 255/5 numbers.
 */
export function fitsWithStubSuffix(basename: string): boolean {
  return Buffer.byteLength(basename) + STUB_SUFFIX.length <= MAX_FILENAME_BYTES;
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

/**
 * Writes a stub file durably (tmp + fsync + rename + directory fsync) so a
 * crash never leaves a half-written stub *or* an ordinary rename that never
 * actually reached disk -- see `durableRename`. This matters more than most
 * of this idiom's other call sites: `stubify` deletes the real file
 * immediately after this returns, on the strength of the stub now standing
 * in for it, so a stub that silently didn't survive a crash here would
 * leave neither a stub nor real content behind.
 */
export function writeStubAtomic(absoluteStubPath: string, hashHex: string): void {
  const tmpPath = inTreeTempPath(absoluteStubPath);
  fs.writeFileSync(tmpPath, formatTaggedHash(hashHex));
  durableRename(tmpPath, absoluteStubPath);
}
