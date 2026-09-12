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

  it("yields nothing for an empty directory", async () => {
    const root = mkTempDir();
    const paths = await collectPaths(root);
    expect(paths).toEqual([]);
  });
});
