import fsp from "node:fs/promises";
import path from "node:path";

export type WalkEntryType = "file" | "dir";
/** Which physical form currently backs this logical path; always "real" for directories. */
export type WalkRepresentation = "real" | "stub" | "both";

export interface WalkEntry {
  /** relative to the walk root, forward-slash separated regardless of OS */
  path: string;
  type: WalkEntryType;
  representation: WalkRepresentation;
  /** mtime of the canonical representation: the real file/dir when present, else the stub */
  mtimeMs: number;
}

const STUB_SUFFIX = ".stub";

interface LogicalFileInfo {
  isDir: boolean;
  hasReal: boolean;
  hasStub: boolean;
}

interface SortItem {
  sortKey: string;
  name: string;
  isDir: boolean;
  isRecurseMarker: boolean;
}

/**
 * Recursively walks `root`, yielding one entry per *logical* file/directory
 * in the same lexicographic order SQL's `ORDER BY path` produces over the
 * equivalent relative path strings -- this is what lets update_cache do a
 * single-pass streaming merge-join against cache.db instead of loading
 * either side fully into memory.
 *
 * A `<name>.stub` file is merged with its real counterpart `<name>` (if any)
 * into one logical entry named `<name>` -- callers never see the literal
 * ".stub" path. `representation` tells them which physical form(s) back it:
 * "real" (an ordinary file), "stub" (materialize-on-demand placeholder), or
 * "both" (a dangling stub alongside its now-materialized real file, which
 * update_cache treats as a cleanup opportunity, never its own tracked path).
 *
 * A naive "sort child names, recurse into a directory as soon as it's
 * reached" traversal gets sibling ordering wrong in general (see the
 * a/a!/a.txt/a-b.txt example in the design docs); the fix here is the same
 * one used for directories, generalized: each directory contributes *two*
 * sort items (its own bare-path entry, sort key = its name; and a "recurse
 * marker", sort key = name + "/"), sorted together with sibling file names,
 * with recursion happening exactly at the marker's position.
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

  const logical = new Map<string, LogicalFileInfo>();
  for (const dirent of dirents) {
    if (relativeDir === "" && excludeAtRoot.has(dirent.name)) continue;

    if (!dirent.isDirectory() && dirent.name.endsWith(STUB_SUFFIX)) {
      const logicalName = dirent.name.slice(0, -STUB_SUFFIX.length);
      const existing = logical.get(logicalName);
      if (existing) {
        existing.hasStub = true;
      } else {
        logical.set(logicalName, { isDir: false, hasReal: false, hasStub: true });
      }
      continue;
    }

    const existing = logical.get(dirent.name);
    if (existing) {
      existing.hasReal = true;
      existing.isDir = dirent.isDirectory();
    } else {
      logical.set(dirent.name, { isDir: dirent.isDirectory(), hasReal: true, hasStub: false });
    }
  }

  const items: SortItem[] = [];
  for (const [name, info] of logical) {
    items.push({ sortKey: name, name, isDir: info.isDir, isRecurseMarker: false });
    if (info.isDir) {
      items.push({ sortKey: `${name}/`, name, isDir: true, isRecurseMarker: true });
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

    if (item.isDir) {
      const stats = await fsp.stat(absolutePath);
      yield { path: relativePath, type: "dir", representation: "real", mtimeMs: stats.mtimeMs };
      continue;
    }

    const info = logical.get(item.name);
    /* istanbul ignore next -- always set above for every non-recurse-marker item */
    if (!info) continue;

    if (info.hasReal) {
      const stats = await fsp.stat(absolutePath);
      yield {
        path: relativePath,
        type: "file",
        representation: info.hasStub ? "both" : "real",
        mtimeMs: stats.mtimeMs,
      };
    } else {
      const stubStats = await fsp.stat(`${absolutePath}${STUB_SUFFIX}`);
      yield {
        path: relativePath,
        type: "file",
        representation: "stub",
        mtimeMs: stubStats.mtimeMs,
      };
    }
  }
}
