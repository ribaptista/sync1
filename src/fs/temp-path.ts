import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** A sibling path next to `basePath`, tagged for its purpose, with a random suffix to avoid collisions. */
export function tempSiblingPath(basePath: string, tag: string): string {
  return `${basePath}.${tag}-${randomBytes(4).toString("hex")}`;
}

const IN_TREE_TEMP_SUFFIX = "sync1-tmp";
const IN_TREE_TEMP_NAME_RE = /\.sync1-tmp-[0-9a-f]{8}(?:\.[^./]+)?$/;

/**
 * A temp path for an atomic write that has to live *in the tracked tree*
 * itself, right next to the real destination -- a download landing next to
 * the file it will replace, or a stub being written next to the original
 * it stands in for -- rather than off in `.sync1/` the way
 * `tempSiblingPath` above is. The one canonical definition every writer
 * (`apply-remote-changes.ts`, `materialize.ts`, `stub.ts`) uses, so the
 * walker's own matcher below can never silently drift out of sync with
 * what's actually being written -- which is exactly how these used to slip
 * past it and get picked up by the next `update_cache` as genuine new
 * files.
 */
export function inTreeTempPath(absolutePath: string): string {
  return `${absolutePath}.${IN_TREE_TEMP_SUFFIX}-${randomBytes(4).toString("hex")}`;
}

/** An in-tree temp path that retains the destination extension for media tools that infer output format from it. */
export function inTreeTempPathPreservingExtension(absolutePath: string): string {
  const extension = path.extname(absolutePath);
  const stem = extension.length > 0 ? absolutePath.slice(0, -extension.length) : absolutePath;
  return `${stem}.${IN_TREE_TEMP_SUFFIX}-${randomBytes(4).toString("hex")}${extension}`;
}

/** True for any name `inTreeTempPath` could have produced -- what the walker excludes so these are never mistaken for tracked content. */
export function isInTreeTempName(name: string): boolean {
  return IN_TREE_TEMP_NAME_RE.test(name);
}

/**
 * Matches any name `tempSiblingPath` could have produced -- a literal dot,
 * a tag of lowercase letters/hyphens, a dash, 8 lowercase hex digits, and
 * (for a temp SQLite DB caught mid-WAL-checkpoint) an optional trailing
 * `-shm`/`-wal` sidecar suffix. Deliberately shape-based rather than
 * listing every tag this codebase happens to use today (`candidate`,
 * `remote-fresh`, `mutate-candidate`, `update-cache-staging`,
 * `gc-candidate`, `tmp`) -- a name-by-name list would silently stop
 * covering a future caller the moment someone adds a new tag and forgets
 * to update this pattern too.
 */
const TEMP_SIBLING_NAME_RE = /\.[a-z][a-z-]*-[0-9a-f]{8}(-shm|-wal)?$/;

/**
 * Removes every leftover `tempSiblingPath` file directly inside
 * `sync1DirPath` -- a candidate/remote-fresh/staging DB (plus its WAL
 * sidecars, if it was caught mid-checkpoint) from a run that was
 * interrupted before its own `finally` could delete it. Ctrl+C's
 * `process.exit()` (`handleTerminationSignal` in `src/cli.ts`) skips every
 * `finally` on the way out, so nothing else ever cleans these up.
 *
 * Only ever safe to call once the caller already holds the lock on this
 * root: that's what guarantees every file matching this shape is trash
 * from a *past*, no-longer-running attempt, never a live sibling some
 * other process still owns -- the lock is exclusive, so nothing else can
 * be mid-write to this directory right now. Called once, from
 * `src/cli.ts`'s `preAction` hook, immediately after `acquireLock()`
 * succeeds and before any command-specific code (which might create its
 * own fresh temp files under the same naming scheme) runs.
 *
 * Best-effort and silent: a missing directory (an uninitialized root, or
 * one of the commands that manage their own lock lifecycle and never call
 * this at all), a file that vanishes between listing and removal, or any
 * other removal failure is skipped rather than failing the whole command
 * over what is, at worst, a few stray bytes left on disk.
 */
export function sweepStaleTempFiles(sync1DirPath: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(sync1DirPath);
  } catch {
    return;
  }
  for (const name of names) {
    if (!TEMP_SIBLING_NAME_RE.test(name)) continue;
    try {
      fs.rmSync(path.join(sync1DirPath, name), { force: true });
    } catch {
      // best-effort only, see doc comment above
    }
  }
}
