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
  it("produces a sibling of the destination, named independently of it, that isInTreeTempName recognizes", () => {
    const result = inTreeTempPath("/vault/photos/summer.jpg");
    expect(result).toMatch(/^\/vault\/photos\/\.sync1-tmp-[0-9a-f]{32}$/);
    expect(isInTreeTempName(path.basename(result))).toBe(true);
  });

  it("does not recognize the real, un-suffixed filename", () => {
    expect(isInTreeTempName("summer.jpg")).toBe(false);
  });

  it("preserves an extension needed for output format inference and recognizes the result", () => {
    const result = inTreeTempPathPreservingExtension("/vault/photos/summer.jpg");
    expect(result).toMatch(/^\/vault\/photos\/\.sync1-tmp-[0-9a-f]{32}\.jpg$/);
    expect(isInTreeTempName(path.basename(result))).toBe(true);
  });

  /**
   * The regression this shape exists for: a temp name built by *extending*
   * the destination's own is longer than the destination, so a legal final
   * path could still have an illegal staging path. A 239-byte thumbnail
   * name became a 258-byte temp -- past the 255-byte filename limit -- and
   * that file could never be generated.
   */
  it("stays far inside the 255-byte filename limit however long the destination name is", () => {
    const longStem = "x".repeat(300);
    for (const result of [
      inTreeTempPath(`/vault/photos/${longStem}.jpg`),
      inTreeTempPathPreservingExtension(`/vault/photos/${longStem}.jpg`),
    ]) {
      const name = path.basename(result);
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
      expect(isInTreeTempName(name)).toBe(true);
    }
  });

  it("carries nothing from the destination, so a multi-byte name can never be split mid-character", () => {
    const name = path.basename(inTreeTempPathPreservingExtension("/vault/photos/日本語の写真.jpg"));
    expect(name).toMatch(/^\.sync1-tmp-[0-9a-f]{32}\.jpg$/);
    expect(Buffer.byteLength(name)).toBe(name.length); // pure ASCII, nothing inherited
  });

  /**
   * Anchored, not suffix-matched. A real file that merely *ends* in the
   * temp shape stays visible to the walker -- being excluded would mean
   * silently never backing it up, and, if it had been tracked before,
   * tombstoning it as deleted on the next scan.
   */
  it("does not recognize a real filename that merely ends in the temp shape", () => {
    expect(isInTreeTempName(`photo.jpg.sync1-tmp-${"a".repeat(32)}.jpg`)).toBe(false);
    expect(isInTreeTempName(`photo.sync1-tmp-${"a".repeat(32)}.jpg`)).toBe(false);
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
