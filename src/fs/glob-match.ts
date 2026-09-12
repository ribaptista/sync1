const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;

/**
 * Converts a SQLite `GLOB` pattern to an equivalent (case-sensitive) JS
 * RegExp: `*` (zero-or-more), `?` (exactly one), `[...]`/`[^...]`
 * character classes, everything else literal. Implemented by hand rather
 * than run through SQLite because the call sites that need matching
 * (update_cache's and apply-remote-changes.ts's merge-joins) hold an open
 * `.iterate()` cursor on the connection whose ignore-policy table they'd
 * otherwise need to query -- see docs/architecture/ignore-and-storage-
 * policies.md. Cross-checked against real SQLite GLOB output in tests.
 */
export function globToRegExp(pattern: string): RegExp {
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

export interface GlobMatchResult {
  matched: boolean;
  pattern?: string;
}

/** The first pattern (if any) that matches `path`, in list order. */
export function matchesAnyGlob(path: string, patterns: readonly string[]): GlobMatchResult {
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(path)) {
      return { matched: true, pattern };
    }
  }
  return { matched: false };
}
