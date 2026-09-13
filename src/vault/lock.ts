import fs from "node:fs";
import os from "node:os";
import { localLockPath, sync1Dir } from "./local-dir.js";
import { tempSiblingPath } from "../fs/temp-path.js";
import { VaultLockedError } from "../errors.js";

export interface LockInfo {
  pid: number;
  acquiredAt: string;
  hostname: string;
}

export interface LockHandle {
  release(): void;
}

/**
 * Whatever lock this process itself currently holds, if any -- tracked so
 * SIGINT/SIGTERM can force-release it without needing to re-derive which
 * root (if any) is currently locked. At most one entry in practice (sync1
 * runs one command per process), but a Set costs nothing extra and quietly
 * survives a hypothetical future where that's no longer true.
 */
const activeLockPaths = new Set<string>();

function isLockInfo(value: unknown): value is LockInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<LockInfo>).pid === "number" &&
    typeof (value as Partial<LockInfo>).acquiredAt === "string" &&
    typeof (value as Partial<LockInfo>).hostname === "string"
  );
}

function readExistingLock(lockPath: string): LockInfo | undefined {
  let content: string;
  try {
    content = fs.readFileSync(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      `lock file "${lockPath}" exists but is not valid JSON -- inspect and remove it manually before retrying`,
    );
  }
  if (!isLockInfo(parsed)) {
    throw new Error(
      `lock file "${lockPath}" exists but is malformed -- inspect and remove it manually before retrying`,
    );
  }
  return parsed;
}

/** Whether a process with this pid is still alive -- never actually signals it (signal 0). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Acquires the per-vault lock at `<root>/.sync1/lock`, throwing
 * `VaultLockedError` if another live process already holds it. This is
 * advisory (read-then-write), not an OS-level `flock`/`O_EXCL` lock -- a
 * narrow race between two processes starting at the exact same instant is
 * a known, accepted limitation; the goal is catching the common case (an
 * accidental second run, or resuming after a crash), not a distributed-lock
 * guarantee.
 *
 * A lock file that exists but can't be parsed is never treated as stale --
 * that would risk silently overwriting a lock written by some future format
 * this version doesn't recognize. It throws a plain `Error` instead, asking
 * the user to inspect/remove it by hand.
 *
 * If `.sync1/` doesn't exist at all (an uninitialized/unattached root),
 * this is a no-op returning a do-nothing handle -- there's no vault state
 * here yet to protect, and the caller's own "not initialized" check (run
 * immediately after this) will fail with its own clear message regardless.
 * Creating `.sync1/` here just to hold a lock file would make an
 * uninitialized root look partially set up, which is worse than not
 * locking at all in this specific case.
 */
export function acquireLock(root: string): LockHandle {
  if (!fs.existsSync(sync1Dir(root))) {
    return { release(): void {} };
  }

  const lockPath = localLockPath(root);
  const existing = readExistingLock(lockPath);

  if (existing && isProcessAlive(existing.pid)) {
    throw new VaultLockedError(
      `vault at "${root}" is locked by pid ${existing.pid} (acquired ${existing.acquiredAt}) -- ` +
        `another sync1 process appears to be running against it; if that process is no longer ` +
        `running, delete "${lockPath}" manually and retry`,
    );
  }

  const info: LockInfo = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    hostname: os.hostname(),
  };
  const tmpPath = tempSiblingPath(lockPath, "tmp");
  fs.writeFileSync(tmpPath, JSON.stringify(info));
  fs.renameSync(tmpPath, lockPath);
  activeLockPaths.add(lockPath);

  return {
    release(): void {
      if (!activeLockPaths.has(lockPath)) return;
      activeLockPaths.delete(lockPath);
      const current = readExistingLock(lockPath);
      if (current && current.pid === process.pid) {
        fs.rmSync(lockPath, { force: true });
      }
    },
  };
}

/**
 * Called only from the SIGINT/SIGTERM handler: unconditionally and
 * synchronously removes every lock this process itself currently holds, no
 * ownership re-check, never throws. The process is exiting immediately
 * regardless of the outcome -- see the "warn, unlock, exit" mandate this
 * exists for.
 */
export function forceReleaseActiveLockSync(): void {
  for (const lockPath of activeLockPaths) {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // best-effort only -- the process is exiting regardless
    }
  }
  activeLockPaths.clear();
}
