import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { globToRegExp, matchesAnyGlob } from "../../../src/fs/glob-match.js";

function realSqliteGlob(pattern: string, testPath: string): boolean {
  const db = new Database(":memory:");
  try {
    const row = db.prepare("SELECT ? GLOB ? AS m").get(testPath, pattern) as { m: number };
    return row.m === 1;
  } finally {
    db.close();
  }
}

const CASES: Array<[pattern: string, path: string]> = [
  ["*.txt", "a.txt"],
  ["*.txt", "a.txt.bak"],
  ["*.txt", ""],
  ["photos/*", "photos/img.jpg"],
  ["photos/*", "photos/sub/img.jpg"],
  ["photos/*", "other/img.jpg"],
  ["a?c", "abc"],
  ["a?c", "ac"],
  ["a?c", "abbc"],
  ["[abc].txt", "a.txt"],
  ["[abc].txt", "b.txt"],
  ["[abc].txt", "d.txt"],
  ["[a-c].txt", "a.txt"],
  ["[a-c].txt", "b.txt"],
  ["[a-c].txt", "z.txt"],
  ["[^abc].txt", "d.txt"],
  ["[^abc].txt", "a.txt"],
  ["ABC", "abc"],
  ["abc", "abc"],
  ["*", "anything/at/all.ext"],
  ["*", ""],
  ["exact.txt", "exact.txt"],
  ["exact.txt", "Exact.txt"],
  ["file.[ch]", "file.c"],
  ["file.[ch]", "file.h"],
  ["file.[ch]", "file.o"],
];

describe("globToRegExp matches real SQLite GLOB semantics", () => {
  it.each(CASES)("pattern %j vs path %j", (pattern, path) => {
    expect(globToRegExp(pattern).test(path)).toBe(realSqliteGlob(pattern, path));
  });
});

describe("matchesAnyGlob", () => {
  it("returns the first matching pattern", () => {
    const result = matchesAnyGlob("photos/img.jpg", ["*.log", "photos/*", "*.tmp"]);
    expect(result).toEqual({ matched: true, pattern: "photos/*" });
  });

  it("returns matched:false when nothing matches", () => {
    const result = matchesAnyGlob("docs/readme.md", ["*.log", "photos/*"]);
    expect(result).toEqual({ matched: false });
  });

  it("returns matched:false for an empty pattern list", () => {
    expect(matchesAnyGlob("anything.txt", [])).toEqual({ matched: false });
  });
});

describe("allowDoubleStar", () => {
  it("without the option, '**' behaves exactly like the existing single-'*' semantics", () => {
    // Untouched default behavior: each '*' independently matches any run of
    // characters including '/', so "**/xyz/*" is just "require a literal
    // '/xyz/' substring somewhere" -- it does NOT match a root-level
    // "xyz/foo.txt" (no leading '/' before "xyz"), unlike double-star mode.
    expect(globToRegExp("**/xyz/*").test("xyz/foo.txt")).toBe(false);
    expect(globToRegExp("**/xyz/*").test("a/b/xyz/foo.txt")).toBe(true);
  });

  it("'**/xyz/*' matches xyz/ at the root and nested under any number of levels", () => {
    const re = globToRegExp("**/xyz/*", { allowDoubleStar: true });
    expect(re.test("xyz/foo.txt")).toBe(true);
    expect(re.test("a/b/xyz/foo.txt")).toBe(true);
    expect(re.test("xyz/sub/foo.txt")).toBe(false);
    expect(re.test("notxyz/foo.txt")).toBe(false);
  });

  it("'xyz/**/*.jpg' matches directly inside xyz/ and under any number of nested levels", () => {
    const re = globToRegExp("xyz/**/*.jpg", { allowDoubleStar: true });
    expect(re.test("xyz/foo.jpg")).toBe(true);
    expect(re.test("xyz/a/b/foo.jpg")).toBe(true);
    expect(re.test("other/foo.jpg")).toBe(false);
    expect(re.test("xyz/foo.png")).toBe(false);
  });

  it("a lone '**' matches everything, including an empty path", () => {
    const re = globToRegExp("**", { allowDoubleStar: true });
    expect(re.test("")).toBe(true);
    expect(re.test("a")).toBe(true);
    expect(re.test("a/b/c.txt")).toBe(true);
  });

  it("consecutive '**' segments collapse to one", () => {
    const re = globToRegExp("a/**/**/b", { allowDoubleStar: true });
    expect(re.test("a/b")).toBe(true);
    expect(re.test("a/x/y/b")).toBe(true);
    expect(re.test("a/c")).toBe(false);
  });

  it("a non-'**' segment never matches across a '/' even in double-star mode", () => {
    const re = globToRegExp("photos/*", { allowDoubleStar: true });
    expect(re.test("photos/img.jpg")).toBe(true);
    expect(re.test("photos/sub/img.jpg")).toBe(false);
  });

  it("'**' at the very end matches the exact prefix plus anything nested under it", () => {
    const re = globToRegExp("photos/**", { allowDoubleStar: true });
    expect(re.test("photos")).toBe(true);
    expect(re.test("photos/img.jpg")).toBe(true);
    expect(re.test("photos/sub/img.jpg")).toBe(true);
    expect(re.test("other/img.jpg")).toBe(false);
  });

  it("character classes and '?' still work per-segment in double-star mode", () => {
    const re = globToRegExp("**/file.[ch]", { allowDoubleStar: true });
    expect(re.test("file.c")).toBe(true);
    expect(re.test("a/b/file.h")).toBe(true);
    expect(re.test("file.o")).toBe(false);
  });

  it("matchesAnyGlob forwards the option through to globToRegExp", () => {
    const result = matchesAnyGlob("xyz/foo.jpg", ["**/xyz/*"], { allowDoubleStar: true });
    expect(result).toEqual({ matched: true, pattern: "**/xyz/*" });
    // Same path/pattern, option omitted -- falls back to the untouched
    // default semantics, which requires a literal '/xyz/' substring and so
    // does not match this root-level path.
    expect(matchesAnyGlob("xyz/foo.jpg", ["**/xyz/*"])).toEqual({ matched: false });
  });
});
