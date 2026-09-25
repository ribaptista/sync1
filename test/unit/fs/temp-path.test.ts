import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  tempSiblingPath,
  inTreeTempPath,
  inTreeTempPathPreservingExtension,
  isInTreeTempName,
  sweepStaleTempFiles,
} from "../../../src/fs/temp-path.js";

const tempDirs: string[] = [];

function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-temp-path-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("tempSiblingPath", () => {
  it("appends the tag and a random hex suffix as a sibling of basePath", () => {
    const result = tempSiblingPath("/root/.sync1/state.db", "candidate");
    expect(result).toMatch(/^\/root\/\.sync1\/state\.db\.candidate-[0-9a-f]{8}$/);
  });

  it("produces a different suffix on every call, even for identical inputs", () => {
    const a = tempSiblingPath("/root/.sync1/state.db", "candidate");
    const b = tempSiblingPath("/root/.sync1/state.db", "candidate");
    expect(a).not.toBe(b);
  });
});

describe("inTreeTempPath / isInTreeTempName", () => {
  it("produces a name isInTreeTempName recognizes", () => {
    const result = inTreeTempPath("/vault/photos/summer.jpg");
    expect(result).toMatch(/^\/vault\/photos\/summer\.jpg\.sync1-tmp-[0-9a-f]{8}$/);
    expect(isInTreeTempName(path.basename(result))).toBe(true);
  });

  it("does not recognize the real, un-suffixed filename", () => {
    expect(isInTreeTempName("summer.jpg")).toBe(false);
  });

  it("preserves an extension needed for output format inference and recognizes the result", () => {
    const result = inTreeTempPathPreservingExtension("/vault/photos/summer.jpg");
    expect(result).toMatch(/^\/vault\/photos\/summer\.sync1-tmp-[0-9a-f]{8}\.jpg$/);
    expect(isInTreeTempName(path.basename(result))).toBe(true);
  });
});

describe("sweepStaleTempFiles", () => {
  it("removes every tempSiblingPath-shaped file, including WAL sidecars, but leaves real vault files alone", () => {
    const sync1Dir = mkTempDir();
    const stale = [
      "state.db.candidate-a1b2c3d4",
      "state.db.candidate-a1b2c3d4-wal",
      "state.db.candidate-a1b2c3d4-shm",
      "state.db.remote-fresh-deadbeef",
      "cache.db.update-cache-staging-01234567",
      "state.db.gc-candidate-89abcdef",
      "state.db.mutate-candidate-fedcba98",
      "lock.tmp-11223344",
    ];
    const real = ["cache.db", "cache.db-shm", "cache.db-wal", "state.db", "lock", "vault.json"];
    for (const name of [...stale, ...real]) {
      fs.writeFileSync(path.join(sync1Dir, name), "x");
    }

    sweepStaleTempFiles(sync1Dir);

    const remaining = fs.readdirSync(sync1Dir).sort();
    expect(remaining).toEqual([...real].sort());
  });

  it("is a silent no-op when the directory doesn't exist at all", () => {
    expect(() => sweepStaleTempFiles("/nonexistent/path/wherever")).not.toThrow();
  });

  it("is a silent no-op on an empty directory", () => {
    const sync1Dir = mkTempDir();
    expect(() => sweepStaleTempFiles(sync1Dir)).not.toThrow();
    expect(fs.readdirSync(sync1Dir)).toEqual([]);
  });

  it("skips a subdirectory rather than trying to rmSync it as a file", () => {
    // Nothing tempSiblingPath produces is ever a directory, but the sweep
    // should never crash if something odd is sitting in .sync1/ that
    // happens to match the name shape.
    const sync1Dir = mkTempDir();
    fs.mkdirSync(path.join(sync1Dir, "state.db.candidate-a1b2c3d4"));
    fs.writeFileSync(path.join(sync1Dir, "state.db.candidate-a1b2c3d4", "inner.txt"), "x");
    expect(() => sweepStaleTempFiles(sync1Dir)).not.toThrow();
  });
});
