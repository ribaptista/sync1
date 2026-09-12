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
