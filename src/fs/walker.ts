import fsp from "node:fs/promises";
import path from "node:path";

export type WalkEntryType = "file" | "dir";

export interface WalkEntry {
  /** relative to the walk root, forward-slash separated regardless of OS */
  path: string;
  type: WalkEntryType;
  mtimeMs: number;
}

interface SortItem {
  sortKey: string;
  name: string;
  isDir: boolean;
  isRecurseMarker: boolean;
}

/**
 * Recursively walks `root`, yielding one entry per file/directory in the
 * same lexicographic order SQL's `ORDER BY path` produces over the
 * equivalent relative path strings — this is what lets update_cache do a
 * single-pass streaming merge-join against cache.db instead of loading
 * either side fully into memory.
 *
 * A naive "sort child names, recurse into a directory as soon as it's
 * reached" traversal gets this wrong: e.g. for siblings "a" (dir), "a.txt"
 * (file), "a/b.txt" (nested file), true string order is
 * "a" < "a.txt" < "a/b.txt" (since '.' 0x2E sorts before '/' 0x2F), but a
 * naive traversal would emit "a" then immediately recurse into it — placing
 * "a/b.txt" before "a.txt", which is wrong. The fix: each directory
 * contributes *two* sort items — its own bare-path entry (sort key = its
 * name) and a "recurse marker" (sort key = name + "/") — sorted together
 * with sibling file names; recursion happens exactly when the merge
 * reaches that marker's position, not immediately upon seeing the
 * directory.
 *
 * Skips `.sync1` at the root (the tool's own bookkeeping directory).
 */
export async function* walk(
  root: string,
  excludeAtRoot: ReadonlySet<string> = new Set([".sync1"]),
): AsyncGenerator<WalkEntry> {
  yield* walkDir(root, "", excludeAtRoot);
}

async function* walkDir(
  absoluteDir: string,
  relativeDir: string,
  excludeAtRoot: ReadonlySet<string>,
): AsyncGenerator<WalkEntry> {
  const dirents = await fsp.readdir(absoluteDir, { withFileTypes: true });

  const items: SortItem[] = [];
  for (const dirent of dirents) {
    if (relativeDir === "" && excludeAtRoot.has(dirent.name)) continue;
    const isDir = dirent.isDirectory();
    items.push({ sortKey: dirent.name, name: dirent.name, isDir, isRecurseMarker: false });
    if (isDir) {
      items.push({
        sortKey: `${dirent.name}/`,
        name: dirent.name,
        isDir: true,
        isRecurseMarker: true,
      });
    }
  }
  items.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  for (const item of items) {
    const relativePath = relativeDir ? `${relativeDir}/${item.name}` : item.name;
    const absolutePath = path.join(absoluteDir, item.name);

    if (item.isRecurseMarker) {
      yield* walkDir(absolutePath, relativePath, excludeAtRoot);
      continue;
    }

    const stats = await fsp.stat(absolutePath);
    yield { path: relativePath, type: item.isDir ? "dir" : "file", mtimeMs: stats.mtimeMs };
  }
}
