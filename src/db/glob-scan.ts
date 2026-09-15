import { matchesAnyGlob, literalPrefixOf } from "../fs/glob-match.js";
import { paginateKeyset } from "./keyset-pagination.js";

/**
 * Keyset-paginated scan filtered by a glob pattern, without any SQL-level
 * `GLOB`/`LIKE` filter -- every row is tested against `pattern` in memory,
 * via the same `matchesAnyGlob` every other glob-matching call site in this
 * codebase uses. No SQL lives here -- the caller supplies its own query via
 * `fetchPage`, per AGENTS.md's "SQL lives only in repositories" rule and
 * `paginateKeyset`'s own convention.
 *
 * A plain "scan everything, filter in memory" would work and be correct on
 * its own, but would force a full table scan for every call, even the
 * overwhelmingly common case of a single named file (`stubify hello.txt`)
 * or a well-anchored subtree (`materialize "Photos/2024/*.jpg"`) -- cases
 * that could otherwise use `path`'s own index. `pattern`'s literal,
 * wildcard-free leading prefix (`literalPrefixOf`, derived from minimatch's
 * own parse tree) lets the caller's `fetchPage` start the very first page
 * at `path >= literalPrefix` instead of the true start of the table
 * (`fetchPage` receives `after === null` only on that first call, exactly
 * like `paginateKeyset`'s own convention -- it's the caller's job to turn
 * that into an inclusive `>=` query, and every later call's real cursor
 * value into a normal exclusive `>` query).
 *
 * Starting inclusively at `literalPrefix` itself (rather than some value
 * before it) is what lets the exact-match case land correctly: a strict
 * `>` seeded with `literalPrefix` would skip a row whose path equals
 * `literalPrefix` exactly (the whole point when `pattern` has no wildcard
 * at all, e.g. `stubify hello.txt`).
 *
 * The stop condition below (`!path.startsWith(literalPrefix)` -> return)
 * needs no "have we entered the matching range yet" tracking, because of a
 * property of sorted strings: for any prefix `P`, the set of strings
 * starting with `P` always forms one contiguous block in sorted order (if
 * `A` and `C` both start with `P` and `A < B < C`, `B`'s leading
 * characters are pinned to agree with `P` too, by transitivity of
 * lexicographic comparison -- `B` can't diverge from `P` without sorting
 * outside `[A, C]`). Starting the scan at `path >= literalPrefix` -- the
 * theoretical minimum of that block -- means the scan is never "not yet
 * arrived": the first row is already inside the block (if it's non-empty)
 * or already past it (if the block is empty), so the very first row
 * failing `startsWith` is unambiguously the end.
 *
 * Correctness never depends on any of the above being exact or even
 * present: every visited row is still independently tested against the
 * real pattern via `matchesAnyGlob` before being yielded. A pattern with
 * no usable literal prefix (`literalPrefixOf` returns `""` -- a
 * leading-wildcard pattern like `"*.jpg"`, or a brace-expanded pattern
 * with more than one alternative) makes `path.startsWith("")` always
 * `true`, so the stop condition never fires and the scan degrades to
 * exactly a plain full scan, still fully correct.
 */
export function paginateKeysetFilteredByGlob<Row>(
  fetchPage: (after: string | null, limit: number) => Row[],
  pathOf: (row: Row) => string,
  pattern: string,
  pageSize = 500,
): IterableIterator<Row> {
  const literalPrefix = literalPrefixOf(pattern);

  function* generator(): Generator<Row> {
    for (const row of paginateKeyset<Row, string>(fetchPage, pathOf, pageSize)) {
      const path = pathOf(row);
      if (!path.startsWith(literalPrefix)) return;
      if (matchesAnyGlob(path, [pattern]).matched) yield row;
    }
  }
  return generator();
}
