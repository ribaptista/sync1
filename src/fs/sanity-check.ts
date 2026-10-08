import fs from "node:fs";
import path from "node:path";
import PQueue from "p-queue";
import type { Logger } from "../logger.js";
import { walk, type WalkEntry } from "./walker.js";
import { readStubHash, stubPathFor, StubFormatError } from "./stub.js";
import { matchesAnyGlob } from "./glob-match.js";
import type { EntriesRepository, EntryRow } from "../db/repositories/entries-repository.js";
import type { ObjectsRepository, ObjectRow } from "../db/repositories/objects-repository.js";
import type { IgnorePoliciesRepository } from "../db/repositories/ignore-policies-repository.js";
import {
  BoundedTaskTracker,
  waitForRoom,
  createPoolErrorBox,
  dispatchTracked,
  throwIfPoolErrored,
  type PoolErrorBox,
} from "../concurrency/pools.js";
import type { HashRunner } from "../concurrency/hash-runner.js";
import { createProgressTracker, type OnProgress, type ProgressTracker } from "../progress-types.js";
import { enumerateSanityCheckWork } from "./sanity-check-enumerate.js";
import type { EnumerationControl } from "./update-cache-enumerate.js";
import type { LocalCiphertextChecksumResult } from "./ciphertext-checksum.js";

export interface HashMismatch {
  path: string;
  expectedHash: string;
  actualHash: string;
}

export interface StubProblem {
  path: string;
  reason: string;
}

export interface MissingInS3 {
  path: string;
  hash: string;
}

/**
 * The CRC64NVME checksum S3 reports for an object (a `HEAD`) disagrees with
 * the one state.db recorded when it was uploaded -- `s3Checksum` is null
 * when S3 reports none at all.
 */
export interface S3ChecksumMismatch {
  path: string;
  hash: string;
  recordedChecksum: string;
  s3Checksum: string | null;
}

/**
 * Re-encrypting the local real file produced a ciphertext whose CRC64NVME
 * checksum differs from the one S3 reports -- or couldn't be computed at all
 * (`localChecksum` null, `reason` saying why, e.g. the file changed while
 * being read).
 */
export interface LocalChecksumMismatch {
  path: string;
  hash: string;
  s3Checksum: string;
  localChecksum: string | null;
  reason: string | null;
}

export interface SanityCheckResult {
  /** Both a stub and the real file present for the same path -- a bad state, never auto-cleaned here. */
  bothStubAndReal: string[];
  hashMismatch: HashMismatch[];
  stubMismatch: StubProblem[];
  missingInS3: MissingInS3[];
  s3ChecksumMismatch: S3ChecksumMismatch[];
  localChecksumMismatch: LocalChecksumMismatch[];
  /** Tracked in state.db, but neither a stub nor a real file exists locally at all. */
  missingLocally: string[];
  /** Present locally, not tracked in state.db, and not matched by any ignore policy. */
  untracked: string[];
  /** Present locally, not tracked, but excluded because an ignore policy matches -- not a problem. */
  ignoredCount: number;
  /**
   * In-tree staging files left by a run that died between writing one and
   * renaming it into place -- Ctrl+C is a `process.exit()`, which skips
   * every `catch`/`finally` that would have removed them. Nothing else
   * ever will: the startup sweep reads only `.sync1/`, and every walk
   * excludes these by name, so they are invisible dead space (a
   * partially-decrypted `materialize` temp can be many GB). Reported, not
   * removed -- this command is read-only.
   */
  staleTempFiles: StaleTempFile[];
}

export interface StaleTempFile {
  path: string;
  size: number;
}

/** What a `HEAD` on an object reports, as far as this check cares. */
export interface ObjectHead {
  /** Full-object CRC64NVME, base64; absent when S3 has none recorded. */
  checksumCrc64Nvme?: string;
}

/**
 * `HEAD`s the object at `s3Key`, resolving null when it doesn't exist --
 * injected rather than taking an S3 client directly, so the merge-join's
 * classification logic (this module's actual complexity) can be
 * unit-tested without a real or mocked S3 client.
 */
export type ObjectHeadChecker = (s3Key: string) => Promise<ObjectHead | null>;

/**
 * Re-encrypts a local file and checksums the ciphertext -- in production
 * `localCiphertextChecksum` (src/fs/ciphertext-checksum.ts) bound to the
 * master key; injected for the same reason as `ObjectHeadChecker`.
 */
export type LocalChecksummer = (
  absolutePath: string,
  hash: string,
  size: number,
  onBytes: (n: number) => void,
) => Promise<LocalCiphertextChecksumResult>;

function emptyResult(): SanityCheckResult {
  return {
    bothStubAndReal: [],
    hashMismatch: [],
    stubMismatch: [],
    missingInS3: [],
    s3ChecksumMismatch: [],
    localChecksumMismatch: [],
    missingLocally: [],
    untracked: [],
    ignoredCount: 0,
    staleTempFiles: [],
  };
}

/**
 * Read-only diagnostic merge-join between the sorted filesystem walk and
 * state.db's sorted entries -- structurally the same streaming comparison
 * update-cache.ts's performUpdateCache uses, but this never writes
 * anything: it exists purely to surface bugs (a corrupt/dangling stub, a
 * tampered file, an entry whose object vanished from S3 or no longer
 * carries the checksum it was uploaded with, an untracked file) that
 * update_cache/materialize would otherwise silently repair or never notice
 * at all. See docs/architecture/ignore-and-storage-policies.md for why
 * ignore-policy matching happens in-memory rather than via SQL.
 *
 * Each tracked file runs a chain of up to three stages, each on its own
 * bounded pool, each dispatched (not awaited) by the one before:
 *
 * 1. **Hash** (`hashRunner`, via `hashJobs`) -- a real file's BLAKE2b,
 *    compared against state.db. A stub skips this: its declared hash is a
 *    cheap synchronous read, checked inline.
 * 2. **HEAD** (`s3Pool`) -- once the hash matches, the object must exist
 *    and S3's CRC64NVME checksum must equal state.db's recorded one.
 * 3. **Re-encrypt** (`streamPool`) -- a real file only, once S3 has
 *    reported a checksum: the local plaintext is encrypted exactly as an
 *    upload would (convergent encryption makes that deterministic) and the
 *    ciphertext's checksum must equal S3's. This is the one check that
 *    proves the local file would reproduce the stored object byte for byte.
 *
 * Every stage's dispatch waits for room in the next pool first, so
 * backpressure runs all the way back to the merge-join itself. Because each
 * stage's own completion is what enqueues the next, the pools must be
 * drained in chain order -- `hashJobs`, then `s3Pool`, then `streamPool` --
 * since only then has every job a stage will ever enqueue been enqueued.
 * All the stage-reported buckets are sorted by path before returning, since
 * completion order isn't merge-join order.
 *
 * `entriesRepo`, `objectsRepo`, and `ignorePoliciesRepo` may all share one
 * connection: `entriesRepo.iterateAllSortedByPath()` is keyset-paginated
 * (src/db/keyset-pagination.ts), not a live `.iterate()` cursor, so the
 * connection is free between pages -- unlike a real cursor, which would
 * forbid any other statement on that same connection while it's open.
 *
 * `filterGlob`, when given, scopes which tracked/untracked paths are
 * actually reported (and, for tracked paths, which ones incur the cost of
 * a rehash/HEAD/re-encrypt) -- the merge-join itself always walks the whole
 * tree and the whole entries table, since a partial merge-join can't tell
 * "filtered out" apart from "genuinely missing" on either side.
 */
export async function performSanityCheck(
  root: string,
  entriesRepo: EntriesRepository,
  objectsRepo: ObjectsRepository,
  ignorePoliciesRepo: IgnorePoliciesRepository,
  headObject: ObjectHeadChecker,
  localChecksum: LocalChecksummer,
  logger: Logger,
  hashRunner: HashRunner,
  maxInFlightHashes: number,
  s3Pool: PQueue,
  s3QueueLimit: number,
  streamPool: PQueue,
  streamQueueLimit: number,
  filterGlob?: string,
  onProgress?: OnProgress,
): Promise<SanityCheckResult> {
  const result = emptyResult();
  const ignoreGlobs = ignorePoliciesRepo.listGlobs();
  const inScope = (p: string): boolean =>
    filterGlob === undefined || matchesAnyGlob(p, [filterGlob]).matched;
  const hashJobs = new BoundedTaskTracker(maxInFlightHashes);

  // filesDone/filesTotal track every row the merge-join consumes (mirroring
  // this scan's pre-existing "scanned" counter); bytesDone/bytesTotal track
  // only content actually read this run -- once to hash it, and once more
  // to re-encrypt it -- see progress-types.ts's own doc comment for the
  // full rule. rowDiscovered() fires once per merge-join step, at the top
  // of the loop below; rowResolved() fires immediately for every
  // synchronous branch (untracked, ignored, out-of-scope, missing-locally,
  // a stub's declared hash) and, for a real file, at the end of its chain,
  // since its re-encrypt stage is byte work too.
  const progress = createProgressTracker(onProgress, ["hashing", "hashed"]);

  // See dispatchTracked's own doc comment (src/concurrency/pools.ts): a
  // pool's onIdle() alone can't tell this function a dispatched job threw,
  // since a rejection just discarded by `void pool.add(...)` becomes an
  // unhandled one -- these turn that into a real, catchable error instead.
  // `hashJobs` needs no equivalent -- `BoundedTaskTracker` already tracks
  // its own dispatched failures (see its own doc comment).
  const ctx: CheckContext = {
    root,
    objectsRepo,
    headObject,
    localChecksum,
    logger,
    result,
    progress,
    s3Pool,
    s3QueueLimit,
    s3PoolErrors: createPoolErrorBox(),
    streamPool,
    streamQueueLimit,
    streamPoolErrors: createPoolErrorBox(),
  };

  // Started, deliberately not awaited: it merge-joins the same two
  // sequences this loop is about to, concurrently, so the denominator is
  // known within a walk rather than only once the last hash lands. See
  // sanity-check-enumerate.ts.
  const enumerationControl: EnumerationControl = { stop: false };
  const enumeration = enumerateSanityCheckWork(
    root,
    entriesRepo,
    filterGlob,
    progress,
    logger,
    enumerationControl,
  );

  try {
    return await runMergeJoin();
  } finally {
    // The real pass is done (or has thrown), so whatever the counting pass
    // still has left to count is now worthless -- cut it short, join it so
    // it can't publish into a settled tracker, then settle on what
    // actually happened.
    enumerationControl.stop = true;
    await enumeration;
    progress.settle();
  }

  // The whole body of this function, moved behind a name so the
  // enumeration above can be joined and settled in a `finally` without
  // re-indenting or splitting up the merge-join itself. Hoisted, so it's
  // declared after the call that uses it and reads in the order it runs.
  async function runMergeJoin(): Promise<SanityCheckResult> {
    const staleTempPaths: string[] = [];
    const fsIter = walk(root, undefined, (relativePath) => staleTempPaths.push(relativePath));
    const entryIter = entriesRepo.iterateAllSortedByPath();

    let fsNext = await fsIter.next();
    let entryNext = entryIter.next();

    while (!fsNext.done || !entryNext.done) {
      const fsEntry = fsNext.done ? null : fsNext.value;
      const entry = entryNext.done ? null : entryNext.value;

      progress.rowDiscovered();

      if (fsEntry !== null && (entry === null || fsEntry.path < entry.path)) {
        if (inScope(fsEntry.path)) {
          const ignoreMatch = matchesAnyGlob(fsEntry.path, ignoreGlobs);
          if (ignoreMatch.matched) {
            result.ignoredCount++;
          } else {
            result.untracked.push(fsEntry.path);
          }
        }
        // Synchronous either way -- an untracked/ignored path (or one
        // filtered out by --filter) needs no further work.
        progress.rowResolved();
        fsNext = await fsIter.next();
      } else if (entry !== null && (fsEntry === null || entry.path < fsEntry.path)) {
        if (inScope(entry.path)) {
          result.missingLocally.push(entry.path);
          logger.debug({ path: entry.path }, "sanity_check: tracked but missing locally");
        }
        progress.rowResolved();
        entryNext = entryIter.next();
      } else if (fsEntry !== null && entry !== null) {
        if (inScope(entry.path)) {
          await dispatchTrackedEntryCheck(fsEntry, entry, ctx, hashRunner, hashJobs);
        } else {
          // Matched on both sides but out of --filter's scope -- still
          // discovered, still resolved, just never checked.
          progress.rowResolved();
        }
        fsNext = await fsIter.next();
        entryNext = entryIter.next();
      }
    }

    // Draining order matters -- see this function's doc comment: each
    // stage's completion is what enqueues the next stage's job.
    await hashJobs.onIdle();
    await s3Pool.onIdle();
    await streamPool.onIdle();
    throwIfPoolErrored(ctx.s3PoolErrors);
    throwIfPoolErrored(ctx.streamPoolErrors);

    const byPath = (a: { path: string }, b: { path: string }): number =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    result.hashMismatch.sort(byPath);
    result.missingInS3.sort(byPath);
    result.s3ChecksumMismatch.sort(byPath);
    result.localChecksumMismatch.sort(byPath);

    // Sized only now, and only for what the walk actually found: these are
    // rare (one per interrupted write), so the stats cost nothing, and a
    // byte total is the whole reason to report them -- "some leftovers" is
    // not actionable, "3.2 GB of leftovers" is. A temp that vanished
    // between the walk and here is simply not a problem any more.
    for (const relativePath of staleTempPaths) {
      try {
        result.staleTempFiles.push({
          path: relativePath,
          size: fs.statSync(path.join(root, relativePath)).size,
        });
      } catch {
        // gone already, or unreadable -- nothing worth reporting
      }
    }

    return result;
  }
}

/** Everything the per-entry stages share, bundled so each helper takes one argument for it. */
interface CheckContext {
  root: string;
  objectsRepo: ObjectsRepository;
  headObject: ObjectHeadChecker;
  localChecksum: LocalChecksummer;
  logger: Logger;
  result: SanityCheckResult;
  progress: ProgressTracker;
  s3Pool: PQueue;
  s3QueueLimit: number;
  s3PoolErrors: PoolErrorBox;
  streamPool: PQueue;
  streamQueueLimit: number;
  streamPoolErrors: PoolErrorBox;
}

/** Wraps `fn` so only its first call does anything. */
function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

async function dispatchTrackedEntryCheck(
  fsEntry: WalkEntry,
  entry: EntryRow,
  ctx: CheckContext,
  hashRunner: HashRunner,
  hashJobs: BoundedTaskTracker,
): Promise<void> {
  const { result, logger, progress } = ctx;

  if (entry.type === "dir") {
    // Directories carry no content -- existence is the only signal,
    // already confirmed by reaching here.
    progress.rowResolved();
    return;
  }

  if (fsEntry.representation === "both") {
    result.bothStubAndReal.push(entry.path);
    logger.debug({ path: entry.path }, "sanity_check: both a stub and the real file are present");
    progress.rowResolved();
    return;
  }

  const absolutePath = path.join(ctx.root, entry.path);

  if (fsEntry.representation === "real") {
    // Exactly-once, whichever stage turns out to be this row's last: the
    // hash job on a mismatch, the HEAD on a missing object, otherwise the
    // re-encrypt -- all of which may be byte work still pending.
    const rowResolved = once(() => progress.rowResolved());
    progress.expectBytes(fsEntry.size);
    await hashJobs.dispatch(async () => {
      const fileTracker = progress.startFile(entry.path, fsEntry.size);
      let handedOff = false;
      try {
        const actualHash = await hashRunner.run(absolutePath, (n) => fileTracker.advance(n));
        logger.debug({ pool: "hash", inFlight: hashJobs.size }, "completed");
        if (entry.hash !== null && actualHash !== entry.hash) {
          result.hashMismatch.push({ path: entry.path, expectedHash: entry.hash, actualHash });
          return;
        }
        if (!entry.hash) return;
        handedOff = true;
        await dispatchS3Check(ctx, entry.hash, entry.path, absolutePath, rowResolved);
      } finally {
        // Unconditional, per FileTracker's own contract -- see
        // update-cache.ts's dispatchHash for why this matters even on the
        // error paths above.
        fileTracker.finish();
        if (!handedOff) rowResolved();
      }
    });
    logger.debug({ pool: "hash", inFlight: hashJobs.size }, "dispatched");
    return;
  }

  let stubHash: string;
  try {
    stubHash = readStubHash(stubPathFor(absolutePath));
  } catch (err) {
    if (err instanceof StubFormatError) {
      result.stubMismatch.push({ path: entry.path, reason: err.message });
      progress.rowResolved();
      return;
    }
    throw err;
  }
  if (entry.hash !== null && stubHash !== entry.hash) {
    result.stubMismatch.push({
      path: entry.path,
      reason: `stub declares hash ${stubHash}, state.db expects ${entry.hash}`,
    });
    progress.rowResolved();
    return;
  }

  if (!entry.hash) {
    // A file entry should always have a hash; nothing further to verify if
    // it somehow doesn't.
    progress.rowResolved();
    return;
  }
  // No local plaintext to re-encrypt, so the chain ends at the HEAD.
  await dispatchS3Check(ctx, entry.hash, entry.path, null, () => {});
  // A stub's declared hash is read synchronously above (never hashed), and
  // a HEAD isn't byte work, so by the time the dispatch has returned
  // there's no further byte work pending for this row -- resolved at
  // dispatch, not completion.
  progress.rowResolved();
}

/**
 * Stage 2: HEADs the object, comparing S3's checksum against state.db's,
 * then hands a real file (`localPath` non-null) on to stage 3. `onSettled`
 * fires exactly once, when this row's chain has no stage left to run.
 */
async function dispatchS3Check(
  ctx: CheckContext,
  hash: string,
  entryPath: string,
  localPath: string | null,
  onSettled: () => void,
): Promise<void> {
  const { result, logger, s3Pool } = ctx;
  const objectRow = ctx.objectsRepo.get(hash);
  if (!objectRow) {
    result.missingInS3.push({ path: entryPath, hash });
    onSettled();
    return;
  }

  await waitForRoom(s3Pool, ctx.s3QueueLimit);
  dispatchTracked(s3Pool, ctx.s3PoolErrors, async () => {
    let handedOff = false;
    try {
      const head = await ctx.headObject(objectRow.s3_key);
      logger.debug({ pool: "s3", inFlight: s3Pool.pending, queued: s3Pool.size }, "completed");
      if (head === null) {
        result.missingInS3.push({ path: entryPath, hash });
        return;
      }
      const s3Checksum = head.checksumCrc64Nvme ?? null;
      if (s3Checksum !== objectRow.ciphertext_checksum) {
        result.s3ChecksumMismatch.push({
          path: entryPath,
          hash,
          recordedChecksum: objectRow.ciphertext_checksum,
          s3Checksum,
        });
      }
      // Nothing to compare a local checksum against when S3 reports none;
      // that absence is already reported just above.
      if (localPath === null || s3Checksum === null) return;
      handedOff = true;
      await dispatchLocalChecksum(ctx, objectRow, entryPath, localPath, s3Checksum, onSettled);
    } finally {
      if (!handedOff) onSettled();
    }
  });
  logger.debug({ pool: "s3", inFlight: s3Pool.pending, queued: s3Pool.size }, "dispatched");
}

/**
 * Stage 3: re-encrypts the local real file and compares its ciphertext
 * checksum against what S3 reported. Byte work, so it's tracked on the
 * progress bar like the hash pass was.
 */
async function dispatchLocalChecksum(
  ctx: CheckContext,
  objectRow: ObjectRow,
  entryPath: string,
  localPath: string,
  s3Checksum: string,
  onSettled: () => void,
): Promise<void> {
  const { result, logger, progress, streamPool } = ctx;
  await waitForRoom(streamPool, ctx.streamQueueLimit);
  progress.expectBytes(objectRow.size);
  dispatchTracked(streamPool, ctx.streamPoolErrors, async () => {
    const fileTracker = progress.startFile(entryPath, objectRow.size);
    try {
      const local = await ctx.localChecksum(localPath, objectRow.hash, objectRow.size, (n) =>
        fileTracker.advance(n),
      );
      logger.debug(
        { pool: "stream", inFlight: streamPool.pending, queued: streamPool.size },
        "completed",
      );
      if ("error" in local) {
        result.localChecksumMismatch.push({
          path: entryPath,
          hash: objectRow.hash,
          s3Checksum,
          localChecksum: null,
          reason: local.error,
        });
      } else if (local.checksum !== s3Checksum) {
        result.localChecksumMismatch.push({
          path: entryPath,
          hash: objectRow.hash,
          s3Checksum,
          localChecksum: local.checksum,
          reason: null,
        });
      }
    } finally {
      fileTracker.finish();
      onSettled();
    }
  });
  logger.debug(
    { pool: "stream", inFlight: streamPool.pending, queued: streamPool.size },
    "dispatched",
  );
}
