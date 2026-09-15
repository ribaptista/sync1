import { describe, it, expect } from "vitest";
import { paginateKeysetFilteredByGlob } from "../../../src/db/glob-scan.js";

interface Row {
  path: string;
}

/**
 * A synthetic in-memory stand-in for a repository's real `fetchPage`:
 * `after === null` (the very first call) uses an inclusive `>=` bound,
 * every later call uses a normal exclusive `>` bound -- exactly the
 * contract `paginateKeysetFilteredByGlob` expects callers to implement.
 * `calls` records every invocation for the pruning-effectiveness tests.
 */
function makeFetchPage(
  sortedPaths: readonly string[],
  literalPrefixSeed: string,
  calls: { count: number; rowsFetched: number },
) {
  return (after: string | null, limit: number): Row[] => {
    calls.count++;
    const bound = after === null ? literalPrefixSeed : after;
    const startIndex =
      after === null
        ? sortedPaths.findIndex((p) => p >= bound)
        : sortedPaths.findIndex((p) => p > bound);
    if (startIndex === -1) return [];
    const page = sortedPaths.slice(startIndex, startIndex + limit).map((path) => ({ path }));
    calls.rowsFetched += page.length;
    return page;
  };
}

describe("paginateKeysetFilteredByGlob: correctness", () => {
  it("yields only genuinely matching rows, for a pattern with a usable literal prefix", () => {
    const sortedPaths = ["a.txt", "photos/img.jpg", "photos/sub/img.jpg", "zebra.txt"];
    const calls = { count: 0, rowsFetched: 0 };
    const rows = [
      ...paginateKeysetFilteredByGlob(
        makeFetchPage(sortedPaths, "photos", calls),
        (r) => r.path,
        "photos/*",
      ),
    ];
    expect(rows.map((r) => r.path)).toEqual(["photos/img.jpg"]);
  });

  it("yields only genuinely matching rows, for a pattern with no usable literal prefix", () => {
    const sortedPaths = ["a.jpg", "b.txt", "sub/c.jpg", "z.jpg"];
    const calls = { count: 0, rowsFetched: 0 };
    const rows = [
      ...paginateKeysetFilteredByGlob(
        makeFetchPage(sortedPaths, "", calls),
        (r) => r.path,
        "*.jpg",
      ),
    ];
    // leading-wildcard pattern: full scan, but still correctly excludes
    // "sub/c.jpg" (doesn't match -- '*' is segment-bound) and "b.txt"
    expect(rows.map((r) => r.path)).toEqual(["a.jpg", "z.jpg"]);
  });

  it("works correctly for a '**' pattern", () => {
    const sortedPaths = ["a.jpg", "photos/a.jpg", "photos/sub/a.jpg", "z.txt"];
    const calls = { count: 0, rowsFetched: 0 };
    const rows = [
      ...paginateKeysetFilteredByGlob(
        makeFetchPage(sortedPaths, "photos", calls),
        (r) => r.path,
        "photos/**/*.jpg",
      ),
    ];
    // '**' matches zero or more directory levels, so both the direct
    // child and the doubly-nested file match.
    expect(rows.map((r) => r.path)).toEqual(["photos/a.jpg", "photos/sub/a.jpg"]);
  });

  it("works correctly for a brace-expanded pattern (no single literal prefix)", () => {
    const sortedPaths = ["a.gif", "a.jpg", "a.png", "b.jpg"];
    const calls = { count: 0, rowsFetched: 0 };
    const rows = [
      ...paginateKeysetFilteredByGlob(
        makeFetchPage(sortedPaths, "", calls),
        (r) => r.path,
        "a.{jpg,png}",
      ),
    ];
    expect(rows.map((r) => r.path).sort()).toEqual(["a.jpg", "a.png"]);
  });

  it("includes the exact-match row on page one for a wildcard-free pattern", () => {
    const sortedPaths = ["a.txt", "hello.txt", "hello.txt.bak", "zebra.txt"];
    const calls = { count: 0, rowsFetched: 0 };
    const rows = [
      ...paginateKeysetFilteredByGlob(
        makeFetchPage(sortedPaths, "hello.txt", calls),
        (r) => r.path,
        "hello.txt",
      ),
    ];
    // A strict '>' seeded with the literal prefix would have skipped this
    // row entirely -- this is exactly the case the inclusive first page
    // (`>=`) exists to cover.
    expect(rows.map((r) => r.path)).toEqual(["hello.txt"]);
  });
});

describe("paginateKeysetFilteredByGlob: pruning effectiveness", () => {
  function buildManyDirectories(count: number): string[] {
    const paths: string[] = [];
    for (let i = 0; i < count; i++) {
      paths.push(`dir${String(i).padStart(4, "0")}/file.txt`);
    }
    return paths;
  }

  it("visits far fewer rows for a well-anchored pattern than for a leading-wildcard one", () => {
    const sortedPaths = buildManyDirectories(1000); // dir0000/file.txt .. dir0999/file.txt
    const pageSize = 25;

    const anchoredCalls = { count: 0, rowsFetched: 0 };
    const anchoredRows = [
      ...paginateKeysetFilteredByGlob(
        makeFetchPage(sortedPaths, "dir0999", anchoredCalls),
        (r) => r.path,
        "dir0999/*.txt",
        pageSize,
      ),
    ];
    expect(anchoredRows.map((r) => r.path)).toEqual(["dir0999/file.txt"]);
    // Seeded almost at the very end of a 1000-row table -- one page finds
    // the match, a second (empty) page confirms exhaustion.
    expect(anchoredCalls.count).toBeLessThanOrEqual(2);
    expect(anchoredCalls.rowsFetched).toBeLessThanOrEqual(pageSize);

    const unanchoredCalls = { count: 0, rowsFetched: 0 };
    const unanchoredRows = [
      ...paginateKeysetFilteredByGlob(
        makeFetchPage(sortedPaths, "", unanchoredCalls),
        (r) => r.path,
        "*/file.txt",
        pageSize,
      ),
    ];
    expect(unanchoredRows).toHaveLength(1000); // every row matches '*/file.txt'
    // No usable literal prefix -- every one of the 1000 rows had to be
    // fetched, across every page.
    expect(unanchoredCalls.rowsFetched).toBe(1000);
    expect(unanchoredCalls.count).toBeGreaterThan(anchoredCalls.count);
  });

  it("a matching run spanning a page boundary still yields every row correctly", () => {
    // "target/" sorts in the middle, and has more matching rows than one
    // page can hold -- forces the run to span at least two fetchPage calls.
    const before = buildManyDirectories(5).map((p) => `aaa/${p}`);
    const target = Array.from({ length: 7 }, (_, i) => `target/file${i}.txt`);
    const after = buildManyDirectories(5).map((p) => `zzz/${p}`);
    const sortedPaths = [...before, ...target, ...after].sort();
    const pageSize = 3;

    const calls = { count: 0, rowsFetched: 0 };
    const rows = [
      ...paginateKeysetFilteredByGlob(
        makeFetchPage(sortedPaths, "target", calls),
        (r) => r.path,
        "target/*.txt",
        pageSize,
      ),
    ];
    expect(rows.map((r) => r.path).sort()).toEqual([...target].sort());
    expect(calls.count).toBeGreaterThan(1); // the 7-row run didn't fit in one 3-row page
  });
});
