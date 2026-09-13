const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;

export interface GlobToRegExpOptions {
  /**
   * Opt-in, additive `**` (segment-aware "zero or more directory levels")
   * support, off by default so every existing call site (ignore_policies,
   * storage_policies, `--filter` flags) is byte-for-byte unaffected. Used
   * only by thumbnail_policy glob evaluation and `thumbnail`'s own `--glob`.
   */
  allowDoubleStar?: boolean;
}

/**
 * Converts a SQLite `GLOB` pattern to an equivalent (case-sensitive) JS
 * RegExp: `*` (zero-or-more), `?` (exactly one), `[...]`/`[^...]`
 * character classes, everything else literal. Implemented by hand rather
 * than run through SQLite because the call sites that need matching
 * (update_cache's and apply-remote-changes.ts's merge-joins) hold an open
 * `.iterate()` cursor on the connection whose ignore-policy table they'd
 * otherwise need to query -- see docs/architecture/ignore-and-storage-
 * policies.md. Cross-checked against real SQLite GLOB output in tests.
 *
 * With `{ allowDoubleStar: true }`, dispatches instead to a separate,
 * segment-aware `**` implementation (see `globToRegExpDoubleStar`) -- the
 * default-`false` behavior above is completely untouched either way.
 */
export function globToRegExp(pattern: string, options?: GlobToRegExpOptions): RegExp {
  if (options?.allowDoubleStar) {
    return globToRegExpDoubleStar(pattern);
  }

  let regex = "";
  let i = 0;
  const n = pattern.length;

  while (i < n) {
    const c = pattern[i]!;

    if (c === "*") {
      regex += ".*";
      i++;
      continue;
    }

    if (c === "?") {
      regex += ".";
      i++;
      continue;
    }

    if (c === "[") {
      let j = i + 1;
      let body = "";

      if (pattern[j] === "^" || pattern[j] === "!") {
        body += "^";
        j++;
      }
      // A literal ']' is allowed as the first character of the class.
      if (pattern[j] === "]") {
        body += "\\]";
        j++;
      }
      while (j < n && pattern[j] !== "]") {
        const cc = pattern[j]!;
        body += cc === "\\" ? "\\\\" : cc;
        j++;
      }

      if (j < n) {
        regex += `[${body}]`;
        i = j + 1;
      } else {
        // Unterminated '[' -- SQLite treats it as a literal bracket.
        regex += "\\[";
        i++;
      }
      continue;
    }

    regex += REGEX_SPECIAL.test(c) ? `\\${c}` : c;
    i++;
  }

  return new RegExp(`^${regex}$`);
}

/**
 * Converts one `/`-free glob segment to a regex fragment, the same way
 * `globToRegExp` does, except `*`/`?` never match `/` -- cross-segment
 * matching in double-star mode is `**`'s job alone.
 */
function segmentToRegExpFragment(segment: string): string {
  let regex = "";
  let i = 0;
  const n = segment.length;

  while (i < n) {
    const c = segment[i]!;

    if (c === "*") {
      regex += "[^/]*";
      i++;
      continue;
    }

    if (c === "?") {
      regex += "[^/]";
      i++;
      continue;
    }

    if (c === "[") {
      let j = i + 1;
      let body = "";

      if (segment[j] === "^" || segment[j] === "!") {
        body += "^";
        j++;
      }
      if (segment[j] === "]") {
        body += "\\]";
        j++;
      }
      while (j < n && segment[j] !== "]") {
        const cc = segment[j]!;
        body += cc === "\\" ? "\\\\" : cc;
        j++;
      }

      if (j < n) {
        regex += `[${body}]`;
        i = j + 1;
      } else {
        regex += "\\[";
        i++;
      }
      continue;
    }

    regex += REGEX_SPECIAL.test(c) ? `\\${c}` : c;
    i++;
  }

  return regex;
}

/**
 * Segment-aware `**` variant of `globToRegExp`: a `**` path segment matches
 * zero or more full directory levels (so `**\/xyz/*` matches both `xyz/foo`
 * and `a/b/xyz/foo`, and `xyz/**\/*.jpg` matches both `xyz/foo.jpg` and
 * `xyz/a/b/foo.jpg`). Consecutive `**` segments collapse to one. Every other
 * segment matches within a single path component only (`*`/`?` never cross
 * a `/`). A pattern that is just `**` matches anything, including `""`.
 */
function globToRegExpDoubleStar(pattern: string): RegExp {
  const rawSegments = pattern.split("/");
  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (segment === "**" && segments[segments.length - 1] === "**") continue;
    segments.push(segment);
  }

  if (segments.length === 1 && segments[0] === "**") {
    return /^.*$/;
  }

  let regex = "";
  for (let idx = 0; idx < segments.length; idx++) {
    const segment = segments[idx]!;
    const isFirst = idx === 0;
    const isLast = idx === segments.length - 1;

    if (segment === "**") {
      if (isFirst) {
        regex += "(?:[^/]+/)*";
      } else if (isLast) {
        regex += "(?:/[^/]+)*";
      } else {
        regex += "/(?:[^/]+/)*";
      }
      continue;
    }

    if (idx > 0 && segments[idx - 1] !== "**") {
      regex += "/";
    }
    regex += segmentToRegExpFragment(segment);
  }

  return new RegExp(`^${regex}$`);
}

export interface GlobMatchResult {
  matched: boolean;
  pattern?: string;
}

/** The first pattern (if any) that matches `path`, in list order. */
export function matchesAnyGlob(
  path: string,
  patterns: readonly string[],
  options?: GlobToRegExpOptions,
): GlobMatchResult {
  for (const pattern of patterns) {
    if (globToRegExp(pattern, options).test(path)) {
      return { matched: true, pattern };
    }
  }
  return { matched: false };
}
