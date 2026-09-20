import fs from "node:fs";
import path from "node:path";
import { sync1Dir } from "../vault/local-dir.js";

/**
 * Resolves the vault root a command should operate on. An explicit
 * `--root` is still validated exactly as it always was -- resolved to an
 * absolute path, then required to already have a `.sync1/` dir, or this
 * throws the same "does not exist" error every command has always thrown.
 * Omitted, it walks up from the current working directory looking for the
 * nearest ancestor whose `.sync1/` exists -- the same "find the marker
 * directory" convention git uses for `.git/`, so a command can be run from
 * any subdirectory of a vault without repeating `--root` on every call.
 *
 * Only for commands operating on an *existing* vault. `init_remote`/
 * `attach_remote` are the one pair that create a vault's `.sync1/` rather
 * than requiring one -- an ancestor search would be meaningless for them
 * (there's nothing to find yet) and actively wrong (it could silently
 * attach/init into an unrelated ancestor vault instead of the intended
 * empty directory); both default a bare `--root` to `.` instead, not this.
 */
export function resolveRoot(rootOpt: string | undefined): string {
  if (rootOpt !== undefined) {
    const root = path.resolve(rootOpt);
    assertAttached(root);
    return root;
  }

  const found = findAncestorWithSync1(process.cwd());
  if (!found) {
    throw new Error(
      `no ".sync1" vault found in the current directory or any parent directory — pass --root explicitly, or run init_remote/attach_remote first`,
    );
  }
  return found;
}

/**
 * Resolves the root for `init_remote`/`attach_remote` specifically --
 * the one pair of commands that *create* `.sync1/` rather than requiring
 * it already exist. A bare `--root` here defaults to `.` (the current
 * working directory), matching a common CLI convention (`git init`, e.g.)
 * -- never an ancestor search, which would be meaningless (nothing to
 * find yet) and could silently attach/init into an unrelated ancestor
 * vault instead of the empty directory the caller actually meant.
 */
export function resolveBootstrapRoot(rootOpt: string | undefined): string {
  return path.resolve(rootOpt ?? ".");
}

function assertAttached(root: string): void {
  const sync1DirPath = sync1Dir(root);
  if (!fs.existsSync(sync1DirPath)) {
    throw new Error(`"${sync1DirPath}" does not exist — run init_remote or attach_remote first`);
  }
}

function findAncestorWithSync1(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(sync1Dir(dir))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root without finding one
    dir = parent;
  }
}
