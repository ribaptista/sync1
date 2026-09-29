import fs from "node:fs";
import { tempSiblingPath } from "./temp-path.js";

/**
 * Retry wrapper for the filesystem operations `writeFileAtomic`/
 * `copyFileAtomic`/callers below build on -- `renameWithRetry` most notably,
 * used both by those two and directly by the mirror/materialize paths.
 * Traced every call site (see docs/architecture/cross-platform-filesystem.md):
 * sync1's own process never holds a handle on the destination at these
 * points, so this is purely defensive against an *external* process --
 * most commonly a Windows antivirus scanner or search indexer -- transiently
 * locking the file, not a fix to a bug in our own logic.
 */

const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 50;

function isRetryableFsError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    RETRYABLE_CODES.has((err as NodeJS.ErrnoException).code ?? "")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(op: () => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      op();
      return;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isRetryableFsError(err)) throw err;
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

export function renameWithRetry(oldPath: string, newPath: string): Promise<void> {
  return withRetry(() => fs.renameSync(oldPath, newPath));
}

/**
 * Writes `data` to a sibling temp file, `fsync`s it, then publishes it over
 * `dest` with `renameWithRetry` -- so `dest` (in practice, always the local
 * `state.db`) is never seen half-written, whether by a concurrent reader or
 * by a crash. A bare `fs.writeFileSync`/`fs.copyFileSync` straight onto a
 * live destination -- this function's two callers' previous behavior --
 * has neither property: a process that dies mid-write leaves a truncated
 * or zero-length file in place of a good one, blocking every later scan
 * until `fetch_remote` re-fetches it from the vault.
 *
 * Directory-fsync durability (guaranteeing the *rename itself* survives a
 * crash, not just the bytes it points at) is deliberately out of scope
 * here -- that's the broader `durableRename` primitive tracked separately
 * for content writes (materialize/stubify/mirror). This function only
 * closes the narrower, more common gap: an in-place overwrite with no
 * temp file and no atomicity at all.
 */
export async function writeFileAtomic(dest: string, data: Buffer): Promise<void> {
  const tempPath = tempSiblingPath(dest, "atomic-write");
  const fd = fs.openSync(tempPath, "w");
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    await renameWithRetry(tempPath, dest);
  } catch (err) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    throw err;
  }
}

/** As {@link writeFileAtomic}, but the source is an existing file rather than an in-memory buffer. */
export function copyFileAtomic(src: string, dest: string): Promise<void> {
  return writeFileAtomic(dest, fs.readFileSync(src));
}
