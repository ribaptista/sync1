/**
 * Wraps repeated bounded `.all()` calls into a single synchronous iterator,
 * so callers get the same `IterableIterator<T>` shape `.iterate()` gives
 * them, but with the connection fully free between pages -- a `.iterate()`
 * cursor holds its underlying statement open between `.next()` calls
 * (forbidding any other statement on that connection until it's exhausted);
 * `.all()` executes a page to completion and returns a plain array, so the
 * generator below only ever pauses at the JS level (a `yield`), never at
 * the SQLite level. See AGENTS.md's "never hold a blocking DB cursor open"
 * convention. No SQL lives here -- each caller supplies its own query via
 * `fetchPage`, per AGENTS.md's "SQL lives only in repositories" rule.
 */
export function paginateKeyset<Row, Key>(
  fetchPage: (after: Key | null, limit: number) => Row[],
  keyOf: (row: Row) => Key,
  pageSize = 500,
): IterableIterator<Row> {
  function* generator(): Generator<Row> {
    let after: Key | null = null;
    while (true) {
      const page = fetchPage(after, pageSize);
      if (page.length === 0) return;
      for (const row of page) yield row;
      after = keyOf(page[page.length - 1]!);
    }
  }
  return generator();
}
