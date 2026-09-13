import { describe, it, expect, vi } from "vitest";
import { paginateKeyset } from "../../../src/db/keyset-pagination.js";

describe("paginateKeyset", () => {
  it("yields every row across multiple pages, in order", () => {
    const rows = Array.from({ length: 23 }, (_, i) => ({ id: i }));
    const fetchPage = vi.fn((after: number | null, limit: number) => {
      const startIndex = after === null ? 0 : after + 1;
      return rows.slice(startIndex, startIndex + limit);
    });

    const result = [...paginateKeyset(fetchPage, (r) => r.id, 5)];
    expect(result).toEqual(rows);
    // 23 rows at page size 5 -> 4 full pages + 1 short page (3 rows) + 1 empty terminating page
    expect(fetchPage).toHaveBeenCalledTimes(6);
  });

  it("yields nothing for an empty result set, calling fetchPage exactly once", () => {
    const fetchPage = vi.fn(() => [] as { id: number }[]);
    const result = [...paginateKeyset(fetchPage, (r) => r.id, 10)];
    expect(result).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(null, 10);
  });

  it("passes the last row's key as the next page's `after` bookmark", () => {
    const pages = [[{ id: 10 }, { id: 20 }], [{ id: 30 }], [] as { id: number }[]];
    const fetchPage = vi.fn(() => pages.shift()!);
    const result = [...paginateKeyset(fetchPage, (r) => r.id, 2)];
    expect(result).toEqual([{ id: 10 }, { id: 20 }, { id: 30 }]);
    expect(fetchPage).toHaveBeenNthCalledWith(1, null, 2);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 20, 2);
    expect(fetchPage).toHaveBeenNthCalledWith(3, 30, 2);
  });

  it("stops as soon as fetchPage returns fewer than a full page (still consumes it)", () => {
    const fetchPage = vi.fn((after: number | null) => {
      if (after === null) return [{ id: 1 }, { id: 2 }];
      return [];
    });
    const result = [...paginateKeyset(fetchPage, (r) => r.id, 5)];
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("supports partial consumption via the iterator protocol directly (doesn't eagerly fetch all pages)", () => {
    const fetchPage = vi.fn((after: number | null, limit: number) => {
      const start = after ?? 0;
      return Array.from({ length: limit }, (_, i) => ({ id: start + i + 1 }));
    });
    const iter = paginateKeyset(fetchPage, (r) => r.id, 3);
    const first = iter.next();
    expect(first).toEqual({ done: false, value: { id: 1 } });
    // Only the first page should have been fetched so far.
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
