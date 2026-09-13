import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { acquireLock, forceReleaseActiveLockSync } from "../../../src/vault/lock.js";
import { localLockPath } from "../../../src/vault/local-dir.js";
import { VaultLockedError } from "../../../src/errors.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-lock-test-"));
  fs.mkdirSync(path.join(root, ".sync1"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A pid guaranteed to no longer belong to any process. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const pid = result.pid;
  if (pid === undefined) throw new Error("failed to spawn a throwaway child process");
  return pid;
}

describe("acquireLock", () => {
  it("is a no-op (no throw, no file written) when .sync1/ doesn't exist yet", () => {
    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-lock-test-bare-"));
    const handle = acquireLock(bareRoot);
    expect(fs.existsSync(path.join(bareRoot, ".sync1"))).toBe(false);
    expect(() => handle.release()).not.toThrow();
    fs.rmSync(bareRoot, { recursive: true, force: true });
  });

  it("acquires a fresh lock, writing pid/acquiredAt/hostname", () => {
    const handle = acquireLock(root);
    const content = JSON.parse(fs.readFileSync(localLockPath(root), "utf8")) as {
      pid: number;
      acquiredAt: string;
      hostname: string;
    };
    expect(content.pid).toBe(process.pid);
    expect(typeof content.acquiredAt).toBe("string");
    expect(typeof content.hostname).toBe("string");
    handle.release();
  });

  it("throws VaultLockedError when a live process already holds the lock", () => {
    fs.writeFileSync(
      localLockPath(root),
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), hostname: "x" }),
    );
    expect(() => acquireLock(root)).toThrow(VaultLockedError);
    expect(() => acquireLock(root)).toThrow(/locked by pid/);
  });

  it("treats a lock held by a no-longer-running pid as stale and overwrites it", () => {
    const stalePid = deadPid();
    fs.writeFileSync(
      localLockPath(root),
      JSON.stringify({ pid: stalePid, acquiredAt: new Date().toISOString(), hostname: "x" }),
    );
    const handle = acquireLock(root);
    const content = JSON.parse(fs.readFileSync(localLockPath(root), "utf8")) as { pid: number };
    expect(content.pid).toBe(process.pid);
    handle.release();
  });

  it("rejects a malformed lock file rather than silently treating it as stale", () => {
    fs.writeFileSync(localLockPath(root), "not json at all");
    expect(() => acquireLock(root)).toThrow(/malformed|not valid JSON/);
    // and does NOT throw VaultLockedError -- it's a different failure mode
    expect(() => acquireLock(root)).not.toThrow(VaultLockedError);
  });

  it("rejects a lock file missing required fields", () => {
    fs.writeFileSync(localLockPath(root), JSON.stringify({ pid: process.pid }));
    expect(() => acquireLock(root)).toThrow(/malformed/);
  });

  it("release() only removes the lock file if it still records this process's own pid", () => {
    const handle = acquireLock(root);
    // Simulate another process having stolen/rewritten the lock in the meantime.
    fs.writeFileSync(
      localLockPath(root),
      JSON.stringify({ pid: deadPid(), acquiredAt: new Date().toISOString(), hostname: "y" }),
    );
    handle.release();
    expect(fs.existsSync(localLockPath(root))).toBe(true);
  });

  it("release() is a no-op if called twice", () => {
    const handle = acquireLock(root);
    handle.release();
    expect(fs.existsSync(localLockPath(root))).toBe(false);
    expect(() => handle.release()).not.toThrow();
  });
});

describe("forceReleaseActiveLockSync", () => {
  it("removes whatever lock is currently held by this process, without an ownership re-check", () => {
    acquireLock(root);
    expect(fs.existsSync(localLockPath(root))).toBe(true);
    forceReleaseActiveLockSync();
    expect(fs.existsSync(localLockPath(root))).toBe(false);
  });

  it("is a no-op when nothing is currently held", () => {
    expect(() => forceReleaseActiveLockSync()).not.toThrow();
  });
});
