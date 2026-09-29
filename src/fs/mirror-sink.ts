import fs from "node:fs";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inTreeTempPath } from "./temp-path.js";
import { durableRenameWithRetry } from "./durable.js";

/**
 * Errno values worth waiting out on a local or SMB target.
 *
 * `EBUSY`/`EPERM`/`EACCES` are safe-fs.ts's own set -- an antivirus
 * scanner or search indexer holding a handle briefly. The rest are SMB's
 * contribution: a mount that hiccups reports `ETIMEDOUT`/`EHOSTDOWN`/
 * `ENETUNREACH`, a server that restarted reports `ESTALE`, and a signal
 * can leave `EINTR`.
 */
const RETRYABLE_MIRROR_CODES = new Set([
  "EBUSY",
  "EPERM",
  "EACCES",
  "ETIMEDOUT",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ESTALE",
  "EINTR",
]);

/**
 * Conditions no number of retries improves. Called out explicitly rather
 * than left to fall through the set above, because the cost of getting it
 * wrong scales: five retries with backoff, on each of tens of thousands of
 * objects, turns "the mirror drive is full" into a run that takes hours to
 * say so.
 */
const FATAL_MIRROR_CODES = new Set(["ENOSPC", "EDQUOT", "EROFS", "ENAMETOOLONG", "EFBIG"]);

/** Matched to safe-fs.ts's own shape -- bounded, unlike withS3Retry. */
const MAX_MIRROR_ATTEMPTS = 5;
const MIRROR_BASE_DELAY_MS = 50;

function errnoOf(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err
    ? ((err as NodeJS.ErrnoException).code ?? "")
    : "";
}

function isRetryableMirrorError(err: unknown): boolean {
  const code = errnoOf(err);
  return !FATAL_MIRROR_CODES.has(code) && RETRYABLE_MIRROR_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Marks a failure as the *mirror's*, not S3's.
 *
 * The distinction has to survive being thrown through `withS3Retry`,
 * because that retry set contains `ETIMEDOUT` and `ENETUNREACH` -- exactly
 * what a dropped SMB mount reports -- and it has **no attempt limit** by
 * design. An unwrapped mirror errno reaching it would drive an unbounded
 * re-upload loop against S3 because a *local* mount vanished. Wrapping
 * carries no errno of its own, so `withS3Retry` classifies it as
 * non-transient and rethrows on the first attempt, leaving the bounded
 * budget below to decide.
 */
export class MirrorWriteError extends Error {
  constructor(
    readonly target: string,
    override readonly cause: unknown,
  ) {
    super(
      `mirror write to "${target}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "MirrorWriteError";
  }
}

/** Runs `operation`, rethrowing any mirror failure as a `MirrorWriteError`. */
export async function asMirrorWrite<T>(target: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    throw err instanceof MirrorWriteError ? err : new MirrorWriteError(target, err);
  }
}

/**
 * Bounded retry of a whole read-encrypt-write unit, firing only when the
 * *mirror* was the cause. Deliberately unlike `withS3Retry`'s unbounded
 * policy: a dropped uplink comes back, a failing drive or a full
 * filesystem does not, and waiting forever on one is indistinguishable
 * from a hang.
 *
 * Wraps the S3 retry rather than nesting inside it because the retriable
 * unit is the whole thing -- a `Readable` that already errored cannot be
 * replayed, so recovering from either sink means starting the read over.
 */
export async function withMirrorRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const retryable = err instanceof MirrorWriteError && isRetryableMirrorError(err.cause);
      if (attempt >= MAX_MIRROR_ATTEMPTS || !retryable) throw err;
      await sleep(MIRROR_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

/**
 * True when the mirror already holds this object at the expected size.
 *
 * Size, not checksum, and the difference is the point. `encryptedSize` is
 * a pure function, so this stays a single `stat` -- comparing the stored
 * bytes would mean re-reading the whole mirror on every sync. Truncation
 * (a pre-atomic-era file, a failing drive) is caught here for free;
 * corruption that preserves length is `mirror verify --checksum`'s job.
 *
 * Existence alone is a sound "we already have it" answer for the same
 * reason the S3 dedup check is: keys are content-addressed and encryption
 * is convergent, so a file at this path can only ever be this content --
 * and because writes are published by rename, a file at the final path is
 * complete by construction.
 */
export function mirrorObjectExists(absolutePath: string, expectedSize: number): boolean {
  try {
    return fs.statSync(absolutePath).size === expectedSize;
  } catch (err) {
    if (errnoOf(err) === "ENOENT") return false;
    throw err;
  }
}

/**
 * Writes `bytes` to `absolutePath` durably: a sibling temp, fsync'd, then
 * published by rename, with the destination directory itself fsync'd
 * afterward (`durableRenameWithRetry`, `src/fs/durable.ts`). A reader
 * therefore never sees a partial file, an interrupted write leaves an
 * obviously-named orphan rather than a plausible-looking truncated object,
 * and -- the gap a bare rename alone doesn't close -- a crash right after
 * publishing can't silently roll the rename back or leave truncated bytes
 * in its place. This matters more here than at most of this idiom's other
 * call sites: `mirrorObjectExists` (below) trusts a file at the expected
 * size as proof the mirror already holds this content, forever, with no
 * later re-check.
 *
 * The temp is a sibling (`inTreeTempPath`) so the rename cannot cross a
 * filesystem -- on a mirror that is also a network mount, a temp in
 * `/tmp` would silently degrade the rename into a copy, losing atomicity
 * exactly where it matters most.
 */
export async function writeMirrorFile(absolutePath: string, bytes: Buffer): Promise<void> {
  await withMirrorRetry(() =>
    asMirrorWrite(absolutePath, async () => {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      const tempPath = inTreeTempPath(absolutePath);
      try {
        fs.writeFileSync(tempPath, bytes);
      } catch (err) {
        removeQuietly(tempPath);
        throw err;
      }
      await durableRenameWithRetry(tempPath, absolutePath);
    }),
  );
}

/**
 * What a failure of the *secondary* branch should do to the primary.
 *
 * `abort-both` is right when the object will not be committed without both
 * sinks: finishing an upload that is about to be discarded and retried
 * sends gigabytes for nothing.
 *
 * `detach-secondary` is right when the primary's result is worth keeping
 * on its own. The source feeds both branches at once, so at the moment the
 * mirror dies the primary has already received everything up to that byte
 * -- letting the source keep flowing to it alone yields a **complete**
 * object with no re-read, no re-encryption and no re-upload. The declared
 * ContentLength is still met, and `encryptStream`'s hash check still runs,
 * because it lives in the source generator rather than in a branch.
 */
export type TeeFailureMode = "abort-both" | "detach-secondary";

/**
 * Splits one source stream into two consumers that advance in lockstep, so
 * a single read and a single encryption feed both S3 and the mirror.
 *
 * Lockstep is the deliberate trade: S3 goes no faster than the mirror
 * does, in exchange for "a clean sync means a complete mirror" with no
 * reconciliation pass and no partially-mirrored commit to reason about.
 * Node's own backpressure provides it -- the source cannot outrun the
 * slower branch.
 *
 * A source failure always kills both: neither sink should publish content
 * that was never fully produced.
 */
export function teeStream(
  source: Readable,
  onSecondaryFailure: TeeFailureMode = "abort-both",
): { primary: Readable; secondary: Readable } {
  const primary = new PassThrough();
  const secondary = new PassThrough();

  source.on("error", (err) => {
    primary.destroy(err);
    secondary.destroy(err);
  });

  // The primary is the one whose result is being kept, so its failure
  // always ends the secondary -- there is nothing left for the mirror's
  // copy to accompany.
  primary.on("error", () => {
    source.unpipe(secondary);
    secondary.destroy();
  });

  secondary.on("error", () => {
    // `pipe()` does NOT unpipe on a destination error, so without this the
    // source stalls forever waiting for a destroyed stream to drain -- the
    // upload would hang rather than finish.
    source.unpipe(secondary);
    if (onSecondaryFailure === "abort-both") {
      primary.destroy();
    } else {
      // The unpipe above is necessary but, on its own, not sufficient.
      // Node's Readable shares ONE flowing/paused state across every
      // `.pipe()` destination it has -- when a destination backs up or is
      // destroyed mid-write, the source pauses as a whole, not just for
      // that one destination, and unpiping the dead one does not resume
      // it for the survivor. Confirmed directly: with only `unpipe()` and
      // no `resume()`, a destination-secondary failure mid-stream left
      // `primary` paused forever, receiving no more data and never itself
      // erroring or ending -- a genuine hang, not a clean detach, for
      // exactly the case (a mount failing partway through a large
      // transfer) this mode exists to survive.
      if (source.isPaused()) source.resume();
    }
  });

  source.pipe(primary);
  source.pipe(secondary);

  return { primary, secondary };
}

/**
 * Streams ciphertext to the mirror, published durably by
 * `durableRenameWithRetry` on success -- fsync'd before the rename, and the
 * destination directory fsync'd after, same as `writeMirrorFile` above and
 * for the same reason: this file's mere existence at the right size is
 * what `mirrorObjectExists` treats as permanent proof of a complete mirror
 * copy.
 *
 * Unlike S3, the mirror needs no abort seam: nothing is visible at the
 * destination until the rename, so a stream that errors partway simply
 * leaves a temp file that is removed here and swept later. That asymmetry
 * is why `encryptStream`'s hash check has to be careful about *when* it
 * throws for S3's sake, and does not have to be for the mirror's.
 */
export async function writeMirrorStream(absolutePath: string, source: Readable): Promise<void> {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const tempPath = inTreeTempPath(absolutePath);
  try {
    await pipeline(source, fs.createWriteStream(tempPath));
  } catch (err) {
    removeQuietly(tempPath);
    throw err;
  }
  await durableRenameWithRetry(tempPath, absolutePath);
}

/**
 * Best-effort cleanup of a temp whose write already failed. Deliberately
 * swallowing: the original error is what the caller needs to see, and a
 * throw from here would replace it with a less informative one (the exact
 * failure mode fixed in the thumbnail path -- see `asPerFileFsError`).
 * A leaked temp is visible, named, and swept by `mirror verify`.
 */
function removeQuietly(tempPath: string): void {
  try {
    fs.rmSync(tempPath, { force: true });
  } catch {
    // see above
  }
}
