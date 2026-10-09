import fs from "node:fs";
import path from "node:path";
import PQueue from "p-queue";
import type { Logger } from "../logger.js";
import { walk, type WalkEntry } from "./walker.js";
import { readStubHash, stubPathFor, StubFormatError } from "./stub.js";
import { matchesAnyGlob } from "./glob-match.js";
import { hashFile } from "./hash-file.js";
import type { EntriesRepository, EntryRow } from "../db/repositories/entries-repository.js";
import type { ObjectsRepository } from "../db/repositories/objects-repository.js";
import type { IgnorePoliciesRepository } from "../db/repositories/ignore-policies-repository.js";
import {
  waitForRoom,
  createPoolErrorBox,
  dispatchTracked,
  throwIfPoolErrored,
  type PoolErrorBox,
} from "../concurrency/pools.js";
import { createProgressTracker, type OnProgress, type ProgressTracker } from "../progress-types.js";
import { enumerateSanityCheckWork } from "./sanity-check-enumerate.js";
import type { EnumerationControl } from "./update-cache-enumerate.js";

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
 * CRC64NVME, compared three ways: the local real file (re-encrypted, same
 * pass that hashed it -- null for a stub, which has no local plaintext),
 * the checksum `state.db` recorded when the object was uploaded, and what
 * S3's `HEAD` reports right now (null if S3 has none recorded). Reported
 * whenever any two of the non-null values disagree, or S3 reports none at
 * all.
 */
export interface ChecksumMismatch {
  path: string;
  hash: string;
  localChecksum: string | null;
  recordedChecksum: string;
  s3Checksum: string | null;
}

export interface SanityCheckResult {
  /** Both a stub and the real file present for the same path -- a bad state, never auto-cleaned here. */
  bothStubAndReal: string[];
  hashMismatch: HashMismatch[];
  stubMismatch: StubProblem[];
  missingInS3: MissingInS3[];
  checksumMismatch: ChecksumMismatch[];
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
 * Reads a real local file once, producing both its BLAKE2b content hash
 * and (since encryption is convergent -- same master key, same `hash` --
 * see docs/architecture/vault-and-encryption.md) the CRC64NVME checksum of
 * what re-encrypting it would produce. In production,
 * `encryptFileForObject` (src/fs/encrypt-file.ts) bound to the vault's
 * master key, with `hashMismatch: "report"` (never aborts the read on a
 * mismatch -- the point here is to learn the actual hash) and
 * `checksum: true`; injected for the same reason as `ObjectHeadChecker`.
 */
export type LocalReader = (
  absolutePath: string,
  size: number,
  hash: string,
  onBytes: (n: number) => void,
) => Promise<{ plaintextHash: string; ciphertextChecksum: string }>;

function emptyResult(): SanityCheckResult {
  return {
    bothStubAndReal: [],
    hashMismatch: [],
    stubMismatch: [],
    missingInS3: [],
    checksumMismatch: [],
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
 * tampered file, an entry whose object vanished from S3 or whose checksum
 * drifted, an untracked file) that update_cache/materialize would
 * otherwise silently repair or never notice at all. See
 * docs/architecture/ignore-and-storage-policies.md for why ignore-policy
 * matching happens in-memory rather than via SQL.
 *
 * A real file is read exactly once: `readLocal` (dispatched to
 * `streamPool`, a bounded pool of read+encrypt jobs -- CPU-bound, but I/O
 * that overlaps while one job waits on the disk) produces its actual
 * BLAKE2b hash and ciphertext checksum together in the same pass. A
 * mismatched hash is reported (`hashMismatch`) without ever dispatching a
 * `HEAD` -- there's nothing left to usefully compare. A stub's declared
 * hash never touches `streamPool` at all (`readStubHash` is a cheap
 * synchronous read, with no local plaintext to re-encrypt), so it goes
 * straight to the `HEAD` dispatch with no local checksum to compare.
 *
 * Either path, once a hash is known to match state.db, dispatches a `HEAD`
 * to `s3Pool` (network I/O, not CPU work) rather than awaiting it inline;
 * a stream job's own completion is what enqueues its follow-on `HEAD`
 * check, so `streamPool`'s own queue must be drained *before* `s3Pool`'s --
 * only then has every `HEAD` job it will ever enqueue actually been
 * enqueued.
 *
 * Because of this, `hashMismatch`, `missingInS3`, and `checksumMismatch`
 * are no longer necessarily in merge-join (path) order by the time this
 * returns -- all three are sorted by path before being handed back.
 *
 * `entriesRepo`, `objectsRepo`, and `ignorePoliciesRepo` may all share one
 * connection: `entriesRepo.iterateAllSortedByPath()` is keyset-paginated
 * (src/db/keyset-pagination.ts), not a live `.iterate()` cursor, so the
 * connection is free between pages -- unlike a real cursor, which would
 * forbid any other statement on that same connection while it's open.
 *
 * `filterGlob`, when given, scopes which tracked/untracked paths are
 * actually reported (and, for tracked paths, which ones incur the cost of
 * a read/HEAD check) -- the merge-join itself always walks the whole tree
 * and the whole entries table, since a partial merge-join can't tell
 * "filtered out" apart from "genuinely missing" on either side.
 */
export async function performSanityCheck(
  root: string,
  entriesRepo: EntriesRepository,
  objectsRepo: ObjectsRepository,
  ignorePoliciesRepo: IgnorePoliciesRepository,
  headObject: ObjectHeadChecker,
  readLocal: LocalReader,
  logger: Logger,
  streamPool: PQueue,
  streamQueueLimit: number,
  s3Pool: PQueue,
  s3QueueLimit: number,
  filterGlob?: string,
  onProgress?: OnProgress,
): Promise<SanityCheckResult> {
  const result = emptyResult();
  const ignoreGlobs = ignorePoliciesRepo.listGlobs();
  const inScope = (p: string): boolean =>
    filterGlob === undefined || matchesAnyGlob(p, [filterGlob]).matched;

  // filesDone/filesTotal track every row the merge-join consumes (mirroring
  // this scan's pre-existing "scanned" counter); bytesDone/bytesTotal track
  // only content actually read this run -- see progress-types.ts's own doc
  // comment for the full rule. rowDiscovered() fires once per merge-join
  // step, at the top of the loop below; rowResolved() fires immediately for
  // every synchronous branch (untracked, ignored, out-of-scope,
  // missing-locally, a stub's declared hash) and once the single read
  // settles for a real file -- the follow-on HEAD isn't byte work.
  const progress = createProgressTracker(onProgress, ["reading", "read"]);

  // See dispatchTracked's own doc comment (src/concurrency/pools.ts):
  // a pool's onIdle() alone can't tell this function a dispatched job
  // threw, since a rejection just discarded by `void pool.add(...)`
  // becomes an unhandled one -- these turn that into a real, catchable
  // error instead.
  const streamPoolErrors = createPoolErrorBox();
  const s3PoolErrors = createPoolErrorBox();

  // Started, deliberately not awaited: it merge-joins the same two
  // sequences this loop is about to, concurrently, so the denominator is
  // known within a walk rather than only once the last read lands. See
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

  const ctx: CheckContext = {
    objectsRepo,
    headObject,
    logger,
    result,
    s3Pool,
    s3QueueLimit,
    s3PoolErrors,
  };

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
          await dispatchTrackedEntryCheck(
            fsEntry,
            entry,
            root,
            ctx,
            readLocal,
            streamPool,
            streamQueueLimit,
            streamPoolErrors,
            progress,
          );
        } else {
          // Matched on both sides but out of --filter's scope -- still
          // discovered, still resolved, just never checked.
          progress.rowResolved();
        }
        fsNext = await fsIter.next();
        entryNext = entryIter.next();
      }
    }

    // Draining order matters: a stream job's own completion is what
    // enqueues its follow-on HEAD check, so every such enqueue has
    // happened by the time streamPool.onIdle() resolves -- only then is it
    // safe to drain s3Pool too.
    await streamPool.onIdle();
    throwIfPoolErrored(streamPoolErrors);
    await s3Pool.onIdle();
    throwIfPoolErrored(s3PoolErrors);

    const byPath = (a: { path: string }, b: { path: string }): number =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    result.hashMismatch.sort(byPath);
    result.missingInS3.sort(byPath);
    result.checksumMismatch.sort(byPath);

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

/** Everything `dispatchS3Check` needs, bundled so it takes one argument for it. */
interface CheckContext {
  objectsRepo: ObjectsRepository;
  headObject: ObjectHeadChecker;
  logger: Logger;
  result: SanityCheckResult;
  s3Pool: PQueue;
  s3QueueLimit: number;
  s3PoolErrors: PoolErrorBox;
}

async function dispatchTrackedEntryCheck(
  fsEntry: WalkEntry,
  entry: EntryRow,
  root: string,
  ctx: CheckContext,
  readLocal: LocalReader,
  streamPool: PQueue,
  streamQueueLimit: number,
  streamPoolErrors: PoolErrorBox,
  progress: ProgressTracker,
): Promise<void> {
  const { result, logger } = ctx;

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

  const absolutePath = path.join(root, entry.path);

  if (fsEntry.representation === "real") {
    // An entry should always have a hash; without one there's nothing to
    // derive an encryption context from, so fall back to a plain hash-only
    // read (the pre-ciphertext-checksum behavior) rather than skipping the
    // row outright.
    if (!entry.hash) {
      progress.expectBytes(fsEntry.size);
      await waitForRoom(streamPool, streamQueueLimit);
      dispatchTracked(streamPool, streamPoolErrors, async () => {
        const fileTracker = progress.startFile(entry.path, fsEntry.size);
        try {
          await hashFile(absolutePath, (n) => fileTracker.advance(n));
          logger.debug(
            {
              path: entry.path,
              pool: "stream",
              inFlight: streamPool.pending,
              queued: streamPool.size,
            },
            "completed",
          );
        } finally {
          fileTracker.finish();
          progress.rowResolved();
        }
      });
      logger.debug(
        { path: entry.path, pool: "stream", inFlight: streamPool.pending, queued: streamPool.size },
        "dispatched",
      );
      return;
    }

    const hash = entry.hash;
    progress.expectBytes(fsEntry.size);
    await waitForRoom(streamPool, streamQueueLimit);
    dispatchTracked(streamPool, streamPoolErrors, async () => {
      const fileTracker = progress.startFile(entry.path, fsEntry.size);
      try {
        const { plaintextHash, ciphertextChecksum } = await readLocal(
          absolutePath,
          fsEntry.size,
          hash,
          (n) => fileTracker.advance(n),
        );
        logger.debug(
          {
            path: entry.path,
            hash,
            plaintext_hash: plaintextHash,
            pool: "stream",
            inFlight: streamPool.pending,
            queued: streamPool.size,
          },
          "completed",
        );
        if (plaintextHash !== hash) {
          result.hashMismatch.push({
            path: entry.path,
            expectedHash: hash,
            actualHash: plaintextHash,
          });
          logger.debug(
            { path: entry.path, expected_hash: hash, actual_hash: plaintextHash },
            "hash mismatch",
          );
          return;
        }
        await dispatchS3Check(ctx, hash, entry.path, ciphertextChecksum);
      } finally {
        // Unconditional, per FileTracker's own contract -- see
        // update-cache.ts's dispatchHash for why this matters even on the
        // error paths above. rowResolved() lives here too, deliberately:
        // it means "no further BYTE work pending for this row", which is
        // true the instant the read settles -- not once the follow-on HEAD
        // check (dispatchS3Check, above) actually lands. A HEAD isn't byte
        // work, and resolving there instead would leave filesDone lagging
        // behind by the whole s3Pool queue, still advancing well after
        // streamPool.onIdle() has already resolved.
        fileTracker.finish();
        progress.rowResolved();
      }
    });
    logger.debug(
      { path: entry.path, pool: "stream", inFlight: streamPool.pending, queued: streamPool.size },
      "dispatched",
    );
    return;
  }

  let stubHash: string;
  try {
    stubHash = readStubHash(stubPathFor(absolutePath));
  } catch (err) {
    if (err instanceof StubFormatError) {
      result.stubMismatch.push({ path: entry.path, reason: err.message });
      logger.debug({ path: entry.path, reason: err.message }, "stub mismatch");
      progress.rowResolved();
      return;
    }
    throw err;
  }
  logger.debug({ path: entry.path, stub_hash: stubHash }, "stub");
  if (entry.hash !== null && stubHash !== entry.hash) {
    const reason = `stub declares hash ${stubHash}, state.db expects ${entry.hash}`;
    result.stubMismatch.push({ path: entry.path, reason });
    logger.debug({ path: entry.path, reason }, "stub mismatch");
    progress.rowResolved();
    return;
  }

  if (!entry.hash) {
    // A file entry should always have a hash; nothing further to verify if
    // it somehow doesn't.
    progress.rowResolved();
    return;
  }
  // No local plaintext to re-encrypt, so the chain ends at the HEAD --
  // `localChecksum: null` tells dispatchS3Check there's nothing local to
  // compare.
  await dispatchS3Check(ctx, entry.hash, entry.path, null);
  // A stub's declared hash is read synchronously above (never hashed), and
  // a HEAD isn't byte work, so by the time dispatchS3Check's own
  // dispatch-not-await-completion has returned, there's no further byte
  // work pending for this row -- same "resolved at dispatch, not
  // completion" rule as the real-file branch's finally above.
  progress.rowResolved();
}

/**
 * Stage 2: HEADs the object, comparing S3's checksum against state.db's
 * recorded one and (when `localChecksum` isn't null -- there was a local
 * real file to re-encrypt) against that too.
 *
 * Resolves once the HEAD job has been *dispatched* (after `waitForRoom`
 * gives it a slot in `s3Pool`), not once it *completes* -- same
 * dispatch-not-completion rule `waitForRoom`/`dispatchTracked` always
 * follow (src/concurrency/pools.ts). The actual network round trip runs in
 * the background inside `dispatchTracked`'s callback.
 */
async function dispatchS3Check(
  ctx: CheckContext,
  hash: string,
  entryPath: string,
  localChecksum: string | null,
): Promise<void> {
  const { result, logger, s3Pool } = ctx;
  const objectRow = ctx.objectsRepo.get(hash);
  if (!objectRow) {
    result.missingInS3.push({ path: entryPath, hash });
    logger.debug({ path: entryPath, hash }, "missing in s3");
    return;
  }

  await waitForRoom(s3Pool, ctx.s3QueueLimit);
  dispatchTracked(s3Pool, ctx.s3PoolErrors, async () => {
    const head = await ctx.headObject(objectRow.s3_key);
    logger.debug(
      { path: entryPath, hash, pool: "s3", inFlight: s3Pool.pending, queued: s3Pool.size },
      "completed",
    );
    if (head === null) {
      result.missingInS3.push({ path: entryPath, hash });
      logger.debug({ path: entryPath, hash, pool: "s3" }, "missing in s3");
      return;
    }
    const s3Checksum = head.checksumCrc64Nvme ?? null;
    logger.debug(
      { path: entryPath, s3_key: objectRow.s3_key, s3_checksum: s3Checksum, pool: "s3" },
      "HEAD",
    );
    const recordedChecksum = objectRow.ciphertext_checksum;
    const allAgree =
      s3Checksum !== null &&
      s3Checksum === recordedChecksum &&
      (localChecksum === null || localChecksum === recordedChecksum);
    if (!allAgree) {
      result.checksumMismatch.push({
        path: entryPath,
        hash,
        localChecksum,
        recordedChecksum,
        s3Checksum,
      });
      logger.debug(
        {
          path: entryPath,
          hash,
          local_checksum: localChecksum,
          recorded_checksum: recordedChecksum,
          s3_checksum: s3Checksum,
        },
        "checksum mismatch",
      );
    } else {
      logger.debug({ path: entryPath, hash }, "ok");
    }
  });
  logger.debug(
    { path: entryPath, hash, pool: "s3", inFlight: s3Pool.pending, queued: s3Pool.size },
    "dispatched",
  );
}
