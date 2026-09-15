import { Minimatch } from "minimatch";

/**
 * Every glob evaluated anywhere in this codebase (ignore/storage/thumbnail
 * policies, and every command's own glob argument) shares this one fixed
 * matching dialect -- minimatch's native shell-glob semantics (segment-bound
 * `*`/`?`, native `**`, `{a,b}` brace expansion), not SQLite's `GLOB`
 * dialect. There is no SQL `GLOB` left anywhere in this codebase to stay
 * compatible with (see docs/architecture/ignore-and-storage-policies.md),
 * so nothing constrains this to SQLite's narrower syntax anymore.
 *
 * - `dot: true` -- `*`/`?` match dotfiles/dot-directories too, matching this
 *   app's historical (SQLite-`GLOB`-derived) behavior; minimatch's bash-like
 *   default hides them unless asked.
 * - `nonegate: true` -- a leading `!` is matched literally, never treated as
 *   "negate this whole pattern" -- irrelevant to this app's model of a list
 *   of independent patterns, first match wins.
 * - `nocomment: true` -- a leading `#` is matched literally, never treated
 *   as a `.gitignore`-style comment line.
 * - `noext: true` -- extglob syntax (`!(x)`, `+(x)`, etc.) is disabled;
 *   nothing in this app ever opted into it, and leaving it on would give
 *   parentheses in a hand-written policy glob unexpected special meaning.
 *
 * `**` and `{a,b}` brace expansion are left at minimatch's own defaults
 * (both on) -- deliberate, user-visible capabilities every call site now
 * shares equally, not just thumbnail policies as before this file's last
 * rewrite.
 */
const MINIMATCH_OPTIONS = {
  dot: true,
  nonegate: true,
  nocomment: true,
  noext: true,
} as const;

export interface GlobMatchResult {
  matched: boolean;
  pattern?: string;
}

/** The first pattern (if any) that matches `path`, in list order. */
export function matchesAnyGlob(path: string, patterns: readonly string[]): GlobMatchResult {
  for (const pattern of patterns) {
    if (new Minimatch(pattern, MINIMATCH_OPTIONS).match(path)) {
      return { matched: true, pattern };
    }
  }
  return { matched: false };
}

/**
 * The longest leading run of wildcard-free, `/`-joined path segments in
 * `pattern`, or `""` if the first segment already contains a wildcard (or
 * `pattern` brace-expands into more than one alternative, each with its own
 * possibly-different prefix -- there's no single shared prefix to report in
 * that case). Derived directly from minimatch's own parse tree (`.set`, a
 * public, typed property -- also how the `glob` package implements this
 * exact walk-pruning technique) rather than a second, independently
 * hand-rolled wildcard detector that could silently disagree with what
 * minimatch actually treats as literal.
 *
 * Purely a scan-pruning optimization for callers (`src/db/glob-scan.ts`'s
 * keyset-scan range, and `thumbnail`'s filesystem-walk-root pruning for
 * `--glob`) -- returning `""` never affects correctness, only pruning
 * effectiveness; every candidate path is still independently tested against
 * the real pattern via `matchesAnyGlob`.
 */
export function literalPrefixOf(pattern: string): string {
  const { set } = new Minimatch(pattern, MINIMATCH_OPTIONS);
  if (set.length !== 1) return "";

  const literal: string[] = [];
  for (const segment of set[0]!) {
    if (typeof segment !== "string") break; // first wildcard/GLOBSTAR segment -- stop
    literal.push(segment);
  }
  return literal.join("/");
}
