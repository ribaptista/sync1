import path from "node:path";
import PQueue from "p-queue";
import type { Logger } from "../logger.js";
import { walk, type WalkEntry } from "./walker.js";
import { readStubHash, stubPathFor, StubFormatError } from "./stub.js";
import { matchesAnyGlob } from "./glob-match.js";
import type { EntriesRepository, EntryRow } from "../db/repositories/entries-repository.js";
import type { ObjectsRepository } from "../db/repositories/objects-repository.js";
import type { IgnorePoliciesRepository } from "../db/repositories/ignore-policies-repository.js";
import { BoundedTaskTracker, waitForRoom } from "../concurrency/pools.js";
import type { HashRunner } from "../concurrency/hash-runner.js";
import { createProgressTracker, type OnProgress, type ProgressTracker } from "../progress-types.js";

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

export interface SanityCheckResult {
  /** Both a stub and the real file present for the same path -- a bad state, never auto-cleaned here. */
  bothStubAndReal: string[];
  hashMismatch: HashMismatch[];
  stubMismatch: StubProblem[];
  missingInS3: MissingInS3[];
  /** Tracked in state.db, but neither a stub nor a real file exists locally at all. */
  missingLocally: string[];
  /** Present locally, not tracked in state.db, and not matched by any ignore policy. */
  untracked: string[];
  /** Present locally, not tracked, but excluded because an ignore policy matches -- not a problem. */
  ignoredCount: number;
}

/**
 * Checks whether the object a hash refers to still verifiably exists in
 * S3 -- injected rather than taking an S3 client directly, so the merge-
 * join's classification logic (this module's actual complexity) can be
 * unit-tested without a real or mocked S3 client.
 */
export type ObjectExistsChecker = (s3Key: string) => Promise<boolean>;

function emptyResult(): SanityCheckResult {
  return {
    bothStubAndReal: [],
    hashMismatch: [],
    stubMismatch: [],
    missingInS3: [],
    missingLocally: [],
    untracked: [],
    ignoredCount: 0,
  };
}

/**
 * Read-only diagnostic merge-join between the sorted filesystem walk and
 * state.db's sorted entries -- structurally the same streaming comparison
 * update-cache.ts's performUpdateCache uses, but this never writes
 * anything: it exists purely to surface bugs (a corrupt/dangling stub, a
 * tampered file, an entry whose object vanished from S3, an untracked
 * file) that update_cache/materialize would otherwise silently repair or
 * never notice at all. See docs/architecture/ignore-and-storage-policies.md
 * for why ignore-policy matching happens in-memory rather than via SQL.
 *
 * A real file's content hash is *dispatched* to `hashRunner` (worker
 * threads, via `hashJobs`) rather than awaited inline, same as
 * update_cache's classify/dispatch/join split -- the merge-join loop
 * advances immediately, hash jobs run concurrently in the background, and
 * `hashJobs.onIdle()` joins them all before this function returns. A stub's
 * declared hash never needs the hash pool at all (`readStubHash` is a
 * cheap synchronous read), so it's checked inline as always. Either path,
 * once a path's hash is known to match state.db, dispatches its S3
 * existence check to `s3Pool` (a plain bounded async pool -- this is
 * network I/O, not CPU work) rather than awaiting it inline too; a hash
 * job's own completion is what enqueues its follow-on S3 check, so
 * `hashJobs.onIdle()` must be drained *before* `s3Pool.onIdle()` -- only
 * then has every S3 job it will ever enqueue actually been enqueued.
 *
 * Because of this, `hashMismatch` and `missingInS3` are no longer
 * necessarily in merge-join (path) order by the time this returns -- both
 * are sorted by path before being handed back.
 *
 * `entriesRepo`, `objectsRepo`, and `ignorePoliciesRepo` may all share one
 * connection: `entriesRepo.iterateAllSortedByPath()` is keyset-paginated
 * (src/db/keyset-pagination.ts), not a live `.iterate()` cursor, so the
 * connection is free between pages -- unlike a real cursor, which would
 * forbid any other statement on that same connection while it's open.
 *
 * `filterGlob`, when given, scopes which tracked/untracked paths are
 * actually reported (and, for tracked paths, which ones incur the cost of
 * a rehash/HEAD check) -- the merge-join itself always walks the whole
 * tree and the whole entries table, since a partial merge-join can't tell
 * "filtered out" apart from "genuinely missing" on either side.
 */
export async function performSanityCheck(
  root: string,
  entriesRepo: EntriesRepository,
  objectsRepo: ObjectsRepository,
  ignorePoliciesRepo: IgnorePoliciesRepository,
  objectExists: ObjectExistsChecker,
  logger: Logger,
  hashRunner: HashRunner,
  maxInFlightHashes: number,
  s3Pool: PQueue,
  s3QueueLimit: number,
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
  // only content actually hashed this run -- see progress-types.ts's own
  // doc comment for the full rule. rowDiscovered() fires once per
  // merge-join step, at the top of the loop below; rowResolved() fires
  // immediately for every synchronous branch (untracked, ignored,
  // out-of-scope, missing-locally, a stub's declared hash) and is deferred
  // into dispatchTrackedEntryCheck's own hash-completion point for a real
  // file that needed hashing.
  const progress = createProgressTracker(onProgress, ["hashing", "hashed"]);

  const fsIter = walk(root);
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
          objectsRepo,
          objectExists,
          logger,
          result,
          hashRunner,
          hashJobs,
          s3Pool,
          s3QueueLimit,
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

  // Draining order matters: a hash job's own completion is what enqueues
  // its follow-on S3 check, so every such enqueue has happened by the time
  // hashJobs.onIdle() resolves -- only then is it safe to drain s3Pool too.
  await hashJobs.onIdle();
  await s3Pool.onIdle();

  result.hashMismatch.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  result.missingInS3.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return result;
}

async function dispatchTrackedEntryCheck(
  fsEntry: WalkEntry,
  entry: EntryRow,
  root: string,
  objectsRepo: ObjectsRepository,
  objectExists: ObjectExistsChecker,
  logger: Logger,
  result: SanityCheckResult,
  hashRunner: HashRunner,
  hashJobs: BoundedTaskTracker,
  s3Pool: PQueue,
  s3QueueLimit: number,
  progress: ProgressTracker,
): Promise<void> {
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
    progress.expectBytes(fsEntry.size);
    await hashJobs.dispatch(async () => {
      const fileTracker = progress.startFile(absolutePath, fsEntry.size);
      try {
        const actualHash = await hashRunner.run(absolutePath);
        logger.debug({ pool: "hash", inFlight: hashJobs.size }, "completed");
        if (entry.hash !== null && actualHash !== entry.hash) {
          result.hashMismatch.push({ path: entry.path, expectedHash: entry.hash, actualHash });
          return;
        }
        if (!entry.hash) return;
        await dispatchS3Check(
          s3Pool,
          s3QueueLimit,
          entry.hash,
          entry.path,
          objectsRepo,
          objectExists,
          result,
          logger,
        );
      } finally {
        // Unconditional, per FileTracker's own contract -- see
        // update-cache.ts's dispatchHash for why this matters even on the
        // error paths above. rowResolved() lives here too, deliberately:
        // it means "no further BYTE work pending for this row", which is
        // true the instant the hash settles -- not once the follow-on S3
        // existence check (dispatchS3Check, above) actually lands. An S3
        // HEAD isn't byte work, and resolving there instead would leave
        // filesDone lagging behind by the whole s3Pool queue, still
        // advancing well after hashJobs.onIdle() has already resolved.
        fileTracker.finish();
        progress.rowResolved();
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
  await dispatchS3Check(
    s3Pool,
    s3QueueLimit,
    entry.hash,
    entry.path,
    objectsRepo,
    objectExists,
    result,
    logger,
  );
  // A stub's declared hash is read synchronously above (never hashed), so
  // by the time dispatchS3Check's own dispatch-not-await-completion has
  // returned, there's no further byte work pending for this row -- same
  // "resolved at dispatch, not completion" rule as the real-file branch's
  // finally above.
  progress.rowResolved();
}

async function dispatchS3Check(
  s3Pool: PQueue,
  s3QueueLimit: number,
  hash: string,
  entryPath: string,
  objectsRepo: ObjectsRepository,
  objectExists: ObjectExistsChecker,
  result: SanityCheckResult,
  logger: Logger,
): Promise<void> {
  const objectRow = objectsRepo.get(hash);
  if (!objectRow) {
    result.missingInS3.push({ path: entryPath, hash });
    return;
  }

  await waitForRoom(s3Pool, s3QueueLimit);
  void s3Pool.add(async () => {
    const exists = await objectExists(objectRow.s3_key);
    logger.debug({ pool: "s3", inFlight: s3Pool.pending, queued: s3Pool.size }, "completed");
    if (!exists) {
      result.missingInS3.push({ path: entryPath, hash });
    }
  });
  logger.debug({ pool: "s3", inFlight: s3Pool.pending, queued: s3Pool.size }, "dispatched");
}
