import { describe, it, expect } from "vitest";
import { matchesAnyGlob } from "../../../src/fs/glob-match.js";

function matches(pattern: string, path: string): boolean {
  return matchesAnyGlob(path, [pattern]).matched;
}

describe("matchesAnyGlob: basic pattern syntax", () => {
  it("'*' matches zero or more characters within one segment", () => {
    expect(matches("*.txt", "a.txt")).toBe(true);
    expect(matches("*.txt", "a.txt.bak")).toBe(false);
    expect(matches("*", "anything.ext")).toBe(true);
  });

  it("'?' matches exactly one character", () => {
    expect(matches("a?c", "abc")).toBe(true);
    expect(matches("a?c", "ac")).toBe(false);
    expect(matches("a?c", "abbc")).toBe(false);
  });

  it("'[...]'/'[^...]'/'[!...]' character classes", () => {
    expect(matches("[abc].txt", "a.txt")).toBe(true);
    expect(matches("[abc].txt", "d.txt")).toBe(false);
    expect(matches("[a-c].txt", "b.txt")).toBe(true);
    expect(matches("[a-c].txt", "z.txt")).toBe(false);
    expect(matches("[^abc].txt", "d.txt")).toBe(true);
    expect(matches("[^abc].txt", "a.txt")).toBe(false);
    expect(matches("[!abc].txt", "d.txt")).toBe(true);
  });

  it("matching is case-sensitive", () => {
    expect(matches("ABC", "abc")).toBe(false);
    expect(matches("abc", "abc")).toBe(true);
  });

  it("dotfiles/dot-directories are matched like any other name (dot: true)", () => {
    expect(matches("*", ".hidden")).toBe(true);
    expect(matches("**", ".hidden/deep/.dot")).toBe(true);
  });
});

describe("matchesAnyGlob: segment-bound '*'/'?' (the accepted behavior change)", () => {
  it("'*' does not cross '/' -- unlike the old SQLite-GLOB-compatible matcher", () => {
    expect(matches("*.txt", "sub/a.txt")).toBe(false);
    expect(matches("photos/*", "photos/img.jpg")).toBe(true);
    expect(matches("photos/*", "photos/sub/img.jpg")).toBe(false);
  });
});

describe("matchesAnyGlob: '**' (native, always on for every call site)", () => {
  it("a lone '**' matches everything, including an empty path", () => {
    expect(matches("**", "")).toBe(true);
    expect(matches("**", "a")).toBe(true);
    expect(matches("**", "a/b/c.txt")).toBe(true);
  });

  it("'**/xyz/*' matches xyz/ at the root and nested under any number of levels", () => {
    expect(matches("**/xyz/*", "xyz/foo.txt")).toBe(true);
    expect(matches("**/xyz/*", "a/b/xyz/foo.txt")).toBe(true);
    expect(matches("**/xyz/*", "xyz/sub/foo.txt")).toBe(false);
    expect(matches("**/xyz/*", "notxyz/foo.txt")).toBe(false);
  });

  it("'xyz/**/*.jpg' matches directly inside xyz/ and under any number of nested levels", () => {
    expect(matches("xyz/**/*.jpg", "xyz/foo.jpg")).toBe(true);
    expect(matches("xyz/**/*.jpg", "xyz/a/b/foo.jpg")).toBe(true);
    expect(matches("xyz/**/*.jpg", "other/foo.jpg")).toBe(false);
    expect(matches("xyz/**/*.jpg", "xyz/foo.png")).toBe(false);
  });

  it("'**' at the end matches anything nested under the prefix (but not the bare prefix itself)", () => {
    expect(matches("photos/**", "photos/img.jpg")).toBe(true);
    expect(matches("photos/**", "photos/sub/img.jpg")).toBe(true);
    expect(matches("photos/**", "photos")).toBe(false);
    expect(matches("photos/**", "other/img.jpg")).toBe(false);
  });

  it("consecutive '**' segments collapse to one", () => {
    expect(matches("a/**/**/b", "a/b")).toBe(true);
    expect(matches("a/**/**/b", "a/x/y/b")).toBe(true);
    expect(matches("a/**/**/b", "a/c")).toBe(false);
  });

  it("character classes and '?' still work per-segment alongside '**'", () => {
    expect(matches("**/file.[ch]", "file.c")).toBe(true);
    expect(matches("**/file.[ch]", "a/b/file.h")).toBe(true);
    expect(matches("**/file.[ch]", "file.o")).toBe(false);
  });
});

describe("matchesAnyGlob: brace expansion (new capability)", () => {
  it("'{a,b}' expands to alternatives", () => {
    expect(matches("*.{jpg,png}", "a.jpg")).toBe(true);
    expect(matches("*.{jpg,png}", "a.png")).toBe(true);
    expect(matches("*.{jpg,png}", "a.gif")).toBe(false);
  });

  it("combines with '**'", () => {
    expect(matches("**/*.{jpg,png}", "a/b/c.png")).toBe(true);
    expect(matches("**/*.{jpg,png}", "a/b/c.gif")).toBe(false);
  });
});

describe("matchesAnyGlob: negation, comments, and extglob are all disabled", () => {
  it("a leading '!' is matched literally, never treated as whole-pattern negation", () => {
    expect(matches("!foo", "!foo")).toBe(true);
    expect(matches("!foo", "foo")).toBe(false);
  });

  it("a leading '#' is matched literally, never treated as a comment line", () => {
    expect(matches("#foo", "#foo")).toBe(true);
    expect(matches("#foo", "foo")).toBe(false);
  });

  it("extglob syntax is inert -- parens/pipe are literal characters", () => {
    expect(matches("+(a|b).txt", "+(a|b).txt")).toBe(true);
    expect(matches("+(a|b).txt", "a.txt")).toBe(false);
  });
});

describe("matchesAnyGlob: escaped literal wildcard characters", () => {
  it("'\\*' and '\\?' match a filename that actually contains '*'/'?'", () => {
    expect(matches("file\\*.txt", "file*.txt")).toBe(true);
    expect(matches("file\\*.txt", "fileX.txt")).toBe(false);
    expect(matches("file\\?.txt", "file?.txt")).toBe(true);
  });
});

describe("matchesAnyGlob: list semantics", () => {
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
