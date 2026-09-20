import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRoot } from "../../../src/cli/resolve-root.js";

const tempDirs: string[] = [];

function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-resolve-root-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveRoot", () => {
  it("returns the resolved --root verbatim when it has a .sync1/ dir", () => {
    const root = mkTempDir();
    fs.mkdirSync(path.join(root, ".sync1"));
    expect(resolveRoot(root)).toBe(path.resolve(root));
  });

  it("throws the standard 'does not exist' error for an explicit --root with no .sync1/", () => {
    const root = mkTempDir();
    expect(() => resolveRoot(root)).toThrow(/does not exist/);
    expect(() => resolveRoot(root)).toThrow(/init_remote or attach_remote/);
  });

  it("finds the vault when cwd is the root itself", () => {
    const root = mkTempDir();
    fs.mkdirSync(path.join(root, ".sync1"));
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      expect(resolveRoot(undefined)).toBe(path.resolve(root));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("finds the vault when cwd is a nested subdirectory of the root", () => {
    const root = mkTempDir();
    fs.mkdirSync(path.join(root, ".sync1"));
    const nested = path.join(root, "Photos", "2024");
    fs.mkdirSync(nested, { recursive: true });
    const originalCwd = process.cwd();
    process.chdir(nested);
    try {
      expect(resolveRoot(undefined)).toBe(path.resolve(root));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("stops at the nearest ancestor, not an outer one, when both have .sync1/", () => {
    const outer = mkTempDir();
    fs.mkdirSync(path.join(outer, ".sync1"));
    const inner = path.join(outer, "inner-vault");
    fs.mkdirSync(inner);
    fs.mkdirSync(path.join(inner, ".sync1"));
    const nested = path.join(inner, "sub");
    fs.mkdirSync(nested);
    const originalCwd = process.cwd();
    process.chdir(nested);
    try {
      expect(resolveRoot(undefined)).toBe(path.resolve(inner));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("throws a clear error when no ancestor has a .sync1/ dir", () => {
    const root = mkTempDir(); // no .sync1/ anywhere under it
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      expect(() => resolveRoot(undefined)).toThrow(/no ".sync1" vault found/);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
