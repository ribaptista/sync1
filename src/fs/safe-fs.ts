import fs from "node:fs";

/**
 * Retry wrapper for the handful of operations that overwrite the local
 * `state.db` in place. Traced every call site (see
 * docs/architecture/cross-platform-filesystem.md): sync1's own process
 * never holds a handle on the destination at these points, so this is
 * purely defensive against an *external* process -- most commonly a
 * Windows antivirus scanner or search indexer -- transiently locking the
 * file, not a fix to a bug in our own logic.
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

export function copyFileWithRetry(src: string, dest: string): Promise<void> {
  return withRetry(() => fs.copyFileSync(src, dest));
}

export function writeFileWithRetry(dest: string, data: Buffer | string): Promise<void> {
  return withRetry(() => fs.writeFileSync(dest, data));
}
