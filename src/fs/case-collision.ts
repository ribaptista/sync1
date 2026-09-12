/**
 * Normalizes a path for case-insensitive comparison -- the single
 * definition every case-collision checkpoint agrees on. See
 * docs/architecture/cross-platform-filesystem.md.
 */
export function toCollisionKey(path: string): string {
  return path.toLowerCase();
}
