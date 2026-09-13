const WILDCARD_CHARS = /[*?[]/;

/**
 * The longest leading run of wildcard-free, `/`-joined path segments in a
 * glob pattern, or `""` if the first segment already contains a wildcard.
 * Pure walk-scoping optimization for `thumbnail`'s `--glob` flag: since
 * `walk()` has no filter parameter, a caller can root its walk at
 * `path.join(root, literalPrefixOf(glob))` instead of `root` to prune whole
 * directory subtrees the pattern can never match, for the common case of a
 * glob like `"Photos/**"`. Returning `""` never affects correctness, only
 * pruning effectiveness -- every other segment still needs matching
 * in-memory against the full glob.
 */
export function literalPrefixOf(glob: string): string {
  const segments = glob.split("/");
  const literalSegments: string[] = [];

  for (const segment of segments) {
    if (WILDCARD_CHARS.test(segment)) break;
    literalSegments.push(segment);
  }

  return literalSegments.join("/");
}
