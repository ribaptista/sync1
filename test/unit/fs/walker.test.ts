import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { walk } from "../../../src/fs/walker.js";

const tempDirs: string[] = [];

function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-walker-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function collectPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of walk(root)) {
    paths.push(entry.path);
  }
  return paths;
}

describe("walk", () => {
  it("emits paths in true lexicographic order across a directory and its siblings", () => {
    // Deliberately constructed so a naive "recurse immediately" traversal
    // gets it wrong: '!' (0x21) < '.' (0x2E) < '/' (0x2F) < 'b' (0x62), so
    // the correct global order interleaves "a"'s subtree between its
    // siblings, not immediately after "a" itself.
    const root = mkTempDir();
    fs.mkdirSync(path.join(root, "a"));
    fs.writeFileSync(path.join(root, "a", "b.txt"), "nested");
    fs.writeFileSync(path.join(root, "a!"), "bang");
    fs.writeFileSync(path.join(root, "a.txt"), "dot");
    fs.writeFileSync(path.join(root, "ab"), "plain");

    return collectPaths(root).then((paths) => {
      expect(paths).toEqual(["a", "a!", "a.txt", "a/b.txt", "ab"]);
      // sanity: this must match what SQL's ORDER BY path would give the
      // same strings, i.e. plain string sort order
      expect(paths).toEqual([...paths].sort());
    });
  });

  it("recurses into nested directories and reports correct types", async () => {
    const root = mkTempDir();
    fs.mkdirSync(path.join(root, "photos", "2024"), { recursive: true });
    fs.writeFileSync(path.join(root, "photos", "2024", "img.jpg"), "x");
    fs.writeFileSync(path.join(root, "readme.txt"), "y");

    const entries = [];
    for await (const entry of walk(root)) entries.push(entry);

    const byPath = Object.fromEntries(entries.map((e) => [e.path, e.type]));
    expect(byPath).toEqual({
      photos: "dir",
      "photos/2024": "dir",
      "photos/2024/img.jpg": "file",
      "readme.txt": "file",
    });
  });

  it("excludes .sync1 at the root but not elsewhere", async () => {
    const root = mkTempDir();
    fs.mkdirSync(path.join(root, ".sync1"));
    fs.writeFileSync(path.join(root, ".sync1", "state.db"), "x");
    fs.mkdirSync(path.join(root, "nested"));
    fs.mkdirSync(path.join(root, "nested", ".sync1")); // not at root -- should NOT be excluded
    fs.writeFileSync(path.join(root, "keep.txt"), "y");

    const paths = await collectPaths(root);
    expect(paths).not.toContain(".sync1");
    expect(paths).not.toContain(".sync1/state.db");
    expect(paths).toContain("nested/.sync1");
    expect(paths).toContain("keep.txt");
  });

  it("excludes an in-tree temp file (inTreeTempPath's own shape) at any depth, not just the root", async () => {
    const root = mkTempDir();
    fs.writeFileSync(path.join(root, "photo.jpg"), "real content");
    // Exactly what inTreeTempPath/inTreeTempPathPreservingExtension
    // themselves produce -- a download, stub-write, or thumbnail left
    // behind by a run interrupted before its own rename/cleanup ran.
    fs.writeFileSync(path.join(root, `.sync1-tmp-${"a1b2c3d4".repeat(4)}`), "half-written");
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "nested", "video.mp4"), "real content");
    fs.writeFileSync(path.join(root, "nested", `.sync1-tmp-${"deadbeef".repeat(4)}`), "half");
    fs.writeFileSync(path.join(root, "nested", `.sync1-tmp-${"cafebabe".repeat(4)}.mp4`), "half");

    const paths = await collectPaths(root);
    expect(paths).toEqual(["nested", "nested/video.mp4", "photo.jpg"]);
  });

  it("does not exclude a real file that merely ends in the temp-name shape", async () => {
    // The matcher is anchored to the whole basename, not suffix-matched:
    // an in-tree temp name is synthesized end to end, so only a name this
    // tool produced can match. Excluding one of these would mean silently
    // never backing it up -- and, for one already tracked, tombstoning it
    // as deleted on the next scan.
    const root = mkTempDir();
    const hex = "a1b2c3d4".repeat(4);
    fs.writeFileSync(path.join(root, `photo.jpg.sync1-tmp-${hex}.jpg`), "real, odd name");
    fs.writeFileSync(path.join(root, `photo.sync1-tmp-${hex}.jpg.backup`), "real, odd name");

    const paths = await collectPaths(root);
    expect(paths).toEqual([`photo.jpg.sync1-tmp-${hex}.jpg`, `photo.sync1-tmp-${hex}.jpg.backup`]);
  });

  it("yields nothing for an empty directory", async () => {
    const root = mkTempDir();
    const paths = await collectPaths(root);
    expect(paths).toEqual([]);
  });

  it("merges a stub-only file into one logical entry, path stripped of .stub", async () => {
    const root = mkTempDir();
    fs.writeFileSync(path.join(root, "img.jpg.stub"), "blake2b:" + "a".repeat(64));

    const entries = [];
    for await (const entry of walk(root)) entries.push(entry);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: "img.jpg", type: "file", representation: "stub" });
  });

  it("reports 'both' when a real file and its stub coexist", async () => {
    const root = mkTempDir();
    fs.writeFileSync(path.join(root, "img.jpg"), "real bytes");
    fs.writeFileSync(path.join(root, "img.jpg.stub"), "blake2b:" + "a".repeat(64));

    const entries = [];
    for await (const entry of walk(root)) entries.push(entry);

    expect(entries).toHaveLength(1); // one logical entry, not two
    expect(entries[0]).toMatchObject({ path: "img.jpg", type: "file", representation: "both" });
  });

  it("reports 'real' for an ordinary file with no stub", async () => {
    const root = mkTempDir();
    fs.writeFileSync(path.join(root, "img.jpg"), "real bytes");

    const entries = [];
    for await (const entry of walk(root)) entries.push(entry);

    expect(entries).toEqual([expect.objectContaining({ path: "img.jpg", representation: "real" })]);
  });
});
