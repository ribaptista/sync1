import fs from "node:fs";
import path from "node:path";
import { renameWithRetry } from "./safe-fs.js";

/**
 * Reopens an already-written, already-closed file just long enough to
 * `fsync` it, then closes it again.
 *
 * Reopening (rather than requiring every writer to keep its own handle
 * open until this runs) is deliberate: `fsync` acts on the file's
 * underlying data, not on the particular descriptor that wrote it, so a
 * fresh `open` targets exactly the same bytes on disk. This is what lets
 * `durableRename`/`durableRenameWithRetry` below work uniformly whether the
 * temp file was produced by `fs.writeFileSync`, a streamed pipeline, or
 * anything else -- the caller never has to thread a file descriptor
 * through its own write path just to satisfy this module.
 */
function fsyncFile(filePath: string): void {
  const fd = fs.openSync(filePath, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `fsync`s the directory entry itself, so a `rename` into it is durable --
 * not merely atomic. A rename is atomic the instant it happens (a reader
 * only ever sees the old name or the new one), but atomicity alone says
 * nothing about whether that change has reached disk: a crash immediately
 * after an un-fsynced rename can still roll the directory entry back to
 * what it pointed at before, on some filesystems' recovery paths (ext4
 * without `dirsync`, most notably).
 *
 * Deliberately a silent no-op wherever this isn't supported -- Windows
 * (`fs.openSync` on a directory throws), and some network filesystems that
 * accept the open but reject the `fsync` itself. This function's only job
 * is to not make things *worse* than the platform's own guarantees by
 * throwing partway through a publish that has already renamed the file
 * into place; there's nothing further it can do on such a platform, and
 * the file itself (fsynced by `fsyncFile` before the rename) is not at
 * risk either way.
 */
function fsyncDir(dirPath: string): void {
  let fd: number;
  try {
    fd = fs.openSync(dirPath, "r");
  } catch {
    return;
  }
  try {
    fs.fsyncSync(fd);
  } catch {
    // Opened fine but fsync itself isn't supported here (some network
    // mounts report EINVAL/ENOTSUP for a directory fd) -- nothing more to
    // do.
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Publishes `tempPath` over `destPath`: `fsync`s the temp file's data,
 * renames it into place, then `fsync`s the destination directory so the
 * rename itself survives a crash too -- not just the bytes it now points
 * at.
 *
 * This is the missing half of the "write to a sibling temp, then rename"
 * idiom used throughout this codebase (see
 * docs/sequences/flow-atomic-publish.md): the rename alone is atomic
 * *visibility* (nobody ever sees a half-written file), but says nothing
 * about *durability* (whether either the bytes or the rename survive a
 * crash). A bare `fs.renameSync` -- this function's previous behavior at
 * every one of its callers -- can, after a crash at the wrong moment,
 * leave the destination truncated, zero-length, or simply reverted to
 * "not renamed yet", which a later scan then either re-uploads as
 * legitimate new content or re-discovers as still stubbed/missing.
 *
 * No retry on the rename itself -- for a same-filesystem local write
 * (materialize, apply-remote-changes' download, `writeStubAtomic`), an
 * `EBUSY`/`EPERM` from an external lock-holder is rare enough that this
 * codebase has not judged the retry worth adding (see
 * `durableRenameWithRetry` below for the one class of caller where it is:
 * a mirror on a network mount).
 */
export function durableRename(tempPath: string, destPath: string): void {
  fsyncFile(tempPath);
  fs.renameSync(tempPath, destPath);
  fsyncDir(path.dirname(destPath));
}

/**
 * As {@link durableRename}, but the rename itself goes through
 * `renameWithRetry` -- for the mirror writes (`mirror-sink.ts`), which may
 * target a network mount or an external drive where a transient Windows
 * antivirus/indexer lock (`EBUSY`/`EPERM`/`EACCES`) is a real, recoverable
 * possibility.
 */
export async function durableRenameWithRetry(tempPath: string, destPath: string): Promise<void> {
  fsyncFile(tempPath);
  await renameWithRetry(tempPath, destPath);
  fsyncDir(path.dirname(destPath));
}
