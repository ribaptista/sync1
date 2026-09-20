import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type PQueue from "p-queue";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";
import type { CacheEntryRow } from "../db/repositories/cache-entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { EntriesRepository } from "../db/repositories/entries-repository.js";
import { VersionsRepository } from "../db/repositories/versions-repository.js";
import { encryptStream, encryptedSize } from "../crypto/streaming-codec.js";
import { putObjectStream, headObject } from "../s3/client.js";
import { withS3Retry } from "../s3/retry.js";
import { remoteKey, objectKey, type RemoteLocation } from "../vault/paths.js";
import { decideLocalChange } from "./conflict-rules.js";
import { toCollisionKey } from "../fs/case-collision.js";
import { countingReadable } from "../fs/counting-stream.js";
import {
  waitForRoom,
  createPoolErrorBox,
  dispatchTracked,
  throwIfPoolErrored,
} from "../concurrency/pools.js";
import { createProgressTracker, type OnProgress } from "../progress-types.js";

/**
 * Every path successfully applied or resolved as a no-op (so: safe to
 * reconcile to 'unchanged'), mapped to **the version stamp the vault
 * actually holds for that path** once this run is done.
 *
 * That distinction is the whole point of this being a map rather than a set.
 * cache.db's `parent_state_version` is compared against `entries.
 * state_version` for the *same path* (src/sync/conflict-rules.ts), so it has
 * to mirror that path's own row, not the commit that happened to be in
 * flight. A row this run genuinely applied was written to `entries` with
 * this commit's stamp; a row that resolved as a **no-op** never touched
 * `entries` at all, so the vault still holds whatever stamp it held before,
 * and reconciling it to the new commit's stamp would make the very next
 * local edit or delete of that path report a false "modified remotely"
 * conflict.
 *
 * `null` means the vault holds no row for the path at all. Only ever
 * produced for a locally-deleted row (whether the delete was applied or was
 * already gone remotely), which reconciliation removes from cache.db
 * outright rather than stamping -- so the null is never read as a stamp.
 */
export type HandledPathStamps = ReadonlyMap<string, string | null>;

export interface ApplyLocalChangesResult {
  uploadedObjects: number;
  dedupedObjects: number;
  handledPaths: HandledPathStamps;
  /**
   * Count of rows that caused a *real* entries mutation (as opposed to a
   * no-op resolution, which reconciles cache.db but never touches
   * state.db). Whether a new version is worth committing at all should be
   * decided from this, not from `handledPaths.size` -- a sync where every
   * dirty row resolved as a no-op has nothing new to upload.
   */
  appliedCount: number;
  /** { path, reason } for every dirty row left unresolved -- stays dirty in cache.db */
  conflicts: Array<{ path: string; reason: string }>;
}

interface InFlightUpload {
  sourceRows: { path: string; type: CacheEntryRow["type"] }[];
}

/**
 * Folds a snapshot of cache.db's dirty rows into the candidate state.db,
 * applying the create/modified/deleted conflict matrix (src/sync/
 * conflict-rules.ts) against whatever entry currently exists there.
 *
 * Runs as **two passes**, not one, over `dirtyRows` (which
 * `CacheEntriesRepository.iterateDirty()` already yields with every
 * `'deleted'` row first, then everything else -- see src/db/repositories/
 * cache-entries-repository.ts):
 *
 * - **Pass 1 — deletes**, fully sequential (no I/O, no pool). Runs to
 *   complete before Pass 2 even starts reading, which is what lets Pass 2's
 *   collision/existence checks trust a plain read of the live candidate db
 *   again, without needing an in-memory ledger of "what Pass 1 already did".
 * - **Pass 2 — creates/modifies**, decide-then-dispatch. Only the actual
 *   object upload (network I/O) is dispatched to `streamPool` rather than
 *   awaited inline -- the loop advances to the next row immediately, and up
 *   to `streamQueueLimit` uploads run concurrently in the background. Since
 *   `entriesRepo.upsert()` for an uploading row's path only happens once its
 *   upload actually completes, a *later* row in this same pass needs two
 *   small in-flight maps to see what an ordinary DB read can't yet:
 *   `inFlightByHash` lets a same-batch duplicate (two paths uploaded in one
 *   run sharing identical content) attach to the already-in-flight upload
 *   instead of uploading twice; `inFlightByNormalizedPath` extends the
 *   case-collision check the same way. Both are bounded by construction --
 *   an entry only exists while its row's upload is genuinely in flight,
 *   which `streamPool`'s own concurrency limit already caps.
 *
 * Any not-yet-known object content is uploaded (checking `objects` for the
 * hash is the dedup check) before the entry that references it is written
 * -- never the other way around, so a crash never leaves a dangling
 * reference.
 *
 * Conflicting rows are left completely untouched here (and therefore stay
 * dirty in cache.db, since only a caller with the full dirty-rows list can
 * reconcile the successful ones) -- resolving them is a human's job, not
 * this function's.
 */
export async function applyLocalChangesToCandidate(
  candidateDb: Database.Database,
  dirtyRows: Iterable<CacheEntryRow>,
  root: string,
  masterKey: Buffer,
  versionStamp: string,
  s3: { client: S3Client; bucket: string; location: RemoteLocation },
  logger: Logger,
  streamPool: PQueue,
  streamQueueLimit: number,
  onProgress?: OnProgress,
  /**
   * Offline-enumerated totals for this phase, published before the first
   * row is consumed so the bar has a real denominator from t=0 instead of
   * one that climbs as the dirty set is walked. Purely advisory: this
   * function still decides everything for itself, and `settle()` below
   * lands the bar on exactly 100% whether the estimate over- or
   * under-counted. See `enumerateUploadWork` in commit.ts.
   */
  estimatedTotals?: { files: number; bytes: number },
  /**
   * Forces a HEAD check against S3 for any content not already known to
   * the candidate before dispatching a real upload for it -- content-
   * addressed keys plus convergent encryption make this a sound existence
   * check: present means a prior run (most likely one aborted mid-upload,
   * before its own candidate could be promoted) already put the exact same
   * bytes there, so this run can just record the row instead of paying for
   * the PUT again. `false` by default: a HEAD per upload is a real cost on
   * a many-small-files sync, not worth paying on an ordinary clean run.
   * See `performSync` (commit.ts) for how this gets decided --
   * `--verify-remote`, or a durable marker left by exactly the kind of
   * aborted run this exists to recover from.
   */
  verifyRemote = false,
): Promise<ApplyLocalChangesResult> {
  const objectsRepo = new ObjectsRepository(candidateDb);
  const entriesRepo = new EntriesRepository(candidateDb);
  const versionsRepo = new VersionsRepository(candidateDb);

  // Must exist before any entries row can reference it (entries.state_version
  // is a foreign key into versions.version_stamp) -- even if it turns out no
  // row ends up referencing it (all conflicts), the caller discards this
  // whole candidate db in that case, so an unused version row is harmless.
  versionsRepo.insert(versionStamp, new Date().toISOString());

  let uploadedObjects = 0;
  let dedupedObjects = 0;
  let appliedCount = 0;
  const handledPaths = new Map<string, string | null>();
  const conflicts: Array<{ path: string; reason: string }> = [];

  // filesDone/filesTotal track every dirty row consumed across both passes
  // (mirroring other commands' "scanned" counter); bytesDone/bytesTotal
  // track only an actual upload -- a delete, a no-op/conflict resolution,
  // or a same-batch dedup attach all contribute 0, per the universal
  // counting rule in progress-types.ts. rowDiscovered() fires once per row
  // at the top of each pass's loop; rowResolved() fires immediately for
  // every synchronous outcome (conflict, no-op, delete, a non-file apply,
  // a dedup hit already known to `objects`), but is deferred for a row
  // whose content is actually uploaded -- including a same-batch dedup
  // attach, which rides along on the same in-flight upload rather than
  // getting one of its own (see the Pass 2 dispatch below).
  const progress = createProgressTracker(onProgress, ["uploading", "uploaded"]);
  // See dispatchTracked's own doc comment: streamPool.onIdle() alone can't
  // tell this function a dispatched job threw, since a rejection just
  // discarded by `void streamPool.add(...)` becomes an unhandled one --
  // this is what turns that into a real, catchable error instead.
  const streamPoolErrors = createPoolErrorBox();
  if (estimatedTotals) progress.setEstimatedTotals(estimatedTotals);

  const iter = dirtyRows[Symbol.iterator]();
  let next = iter.next();

  // Pass 1: deletes only. iterateDirty() guarantees these come first, so
  // this loop naturally stops the moment it reaches the first non-deleted
  // row, handing off to Pass 2 below without consuming it.
  while (!next.done && next.value.state === "deleted") {
    const row = next.value;
    progress.rowDiscovered();
    const existingEntry = entriesRepo.get(row.path);
    const decision = decideLocalChange(row, existingEntry);

    if (decision.kind === "conflict") {
      conflicts.push({ path: row.path, reason: decision.reason });
      logger.debug({ path: row.path, reason: decision.reason }, "local change conflicts, skipping");
    } else {
      // Always null: this pass only handles deletes, and either branch below
      // leaves the vault with no `entries` row for the path (applied ->
      // removed here; no-op -> it was already gone remotely). Reconciliation
      // drops such cache rows entirely, so no stamp is ever needed.
      handledPaths.set(row.path, null);
      if (decision.kind === "apply") {
        appliedCount++;
        entriesRepo.delete(row.path);
        logger.debug({ path: row.path }, "removing entry (deleted locally)");
      } else {
        logger.debug({ path: row.path }, "local change already reconciled remotely (no-op)");
      }
    }

    // A delete is always fully synchronous -- no I/O, no pool -- so
    // rowResolved() trails rowDiscovered() by nothing more than the
    // decision logic above, but it's still a genuinely separate event.
    progress.rowResolved();
    next = iter.next();
  }

  // Pass 2: creates/modifies.
  const inFlightByHash = new Map<string, InFlightUpload>();
  const inFlightByNormalizedPath = new Map<string, string>();

  while (!next.done) {
    const row = next.value;
    next = iter.next();
    progress.rowDiscovered();

    // Only a genuinely new path can newly collide -- "modified" targets a
    // path that already exists, so decideLocalChange's own exact-path
    // matching already handles those. See docs/architecture/
    // cross-platform-filesystem.md.
    if (row.state === "created") {
      const normalizedKey = toCollisionKey(row.path);
      const dbCollision = entriesRepo.findByNormalizedPath(normalizedKey, row.path);
      const inFlightCollision = inFlightByNormalizedPath.get(normalizedKey);
      const collidesWith =
        dbCollision?.path ?? (inFlightCollision !== row.path ? inFlightCollision : undefined);
      if (collidesWith) {
        const reason = `case-insensitive collision with existing entry "${collidesWith}" -- rename or remove one of them and sync again`;
        conflicts.push({ path: row.path, reason });
        logger.debug({ path: row.path, collidesWith }, "case-insensitive collision, skipping");
        progress.rowResolved();
        continue;
      }
    }

    const existingEntry = entriesRepo.get(row.path);
    const decision = decideLocalChange(row, existingEntry);

    if (decision.kind === "conflict") {
      conflicts.push({ path: row.path, reason: decision.reason });
      logger.debug({ path: row.path, reason: decision.reason }, "local change conflicts, skipping");
      progress.rowResolved();
      continue;
    }

    if (decision.kind === "noop") {
      // Nothing is written to `entries` here, so the vault keeps the stamp
      // it already had for this path -- reconciling the cache row to this
      // run's `versionStamp` instead is what used to produce false
      // "modified remotely" conflicts on the next local change.
      // `existingEntry` is always present for a no-op on a created/modified
      // row (see conflict-rules.ts: both no-op branches are reached only by
      // comparing against an existing entry's hash).
      handledPaths.set(row.path, existingEntry?.state_version ?? null);
      logger.debug({ path: row.path }, "local change already reconciled remotely (no-op)");
      progress.rowResolved();
      continue;
    }

    // decision.kind === "apply" -- every branch below writes this path into
    // `entries` at `versionStamp`, so that is what the vault will hold.
    // `handledPaths`/`appliedCount` themselves, though, are recorded at
    // each branch's own point of actually succeeding, not here: a row
    // whose upload later fails must never be reported as applied, or
    // reconcileCacheAfterCommit would mark it 'unchanged' and silently
    // lose the pending local change it represents. Only the branches with
    // no async gap between "decided" and "written" (this one, and the
    // dedup-hit branch below) can safely record it immediately; the
    // dispatched-upload branch further down records it from the job's own
    // success path instead.

    if (row.type !== "file") {
      handledPaths.set(row.path, versionStamp);
      appliedCount++;
      entriesRepo.upsert({
        path: row.path,
        type: row.type,
        hash: null,
        state_version: versionStamp,
      });
      progress.rowResolved();
      continue;
    }

    if (!row.hash) {
      throw new Error(`cache row for "${row.path}" is a file with no recorded hash`);
    }
    const hash = row.hash;

    if (row.state === "created") {
      inFlightByNormalizedPath.set(toCollisionKey(row.path), row.path);
    }

    const existingJob = inFlightByHash.get(hash);
    if (existingJob) {
      existingJob.sourceRows.push({ path: row.path, type: row.type });
      logger.debug(
        { path: row.path, hash },
        "content already in flight this batch, attaching (dedup)",
      );
      // Not counted as deduped here, and rowResolved() deliberately NOT
      // called here either -- this row has no upload of its own and
      // hasn't actually been applied yet, only provisionally attached to
      // a job that might still fail. It resolves (and is counted, either
      // way) alongside every other row riding on that job, from the same
      // success/failure accounting the dispatching row itself goes
      // through -- see the streamPool.add callback below.
      continue;
    }

    if (objectsRepo.has(hash)) {
      dedupedObjects++;
      handledPaths.set(row.path, versionStamp);
      appliedCount++;
      logger.debug({ path: row.path, hash }, "content already known, skipping upload (dedup)");
      entriesRepo.upsert({ path: row.path, type: row.type, hash, state_version: versionStamp });
      progress.rowResolved();
      continue;
    }

    // verifyRemote only: not known to *this* candidate, but a prior run's
    // upload could still have reached S3 before it got aborted -- object
    // records only ever live in whatever candidate DB that run was using,
    // discarded along with everything else it never got to promote. A HEAD
    // is a sound existence check here specifically because the key is
    // content-addressed and encryption is convergent: present can only
    // mean this exact plaintext, encrypted the exact same way, already
    // made it. Awaited inline, not dispatched -- this only ever runs
    // during the slow, recovery-mode path, so trading some parallelism for
    // a simpler decide-then-dispatch shape is the right call here.
    if (verifyRemote) {
      const existingKey = objectKey(hash);
      const head = await headObject(s3.client, s3.bucket, remoteKey(s3.location, existingKey));
      if (head) {
        dedupedObjects++;
        handledPaths.set(row.path, versionStamp);
        appliedCount++;
        logger.debug(
          { path: row.path, hash },
          "content already present in S3 from a prior aborted run -- skipping re-upload (verify-remote)",
        );
        // Unlike the objectsRepo.has(hash) branch above, this candidate
        // never had an objects row for this hash at all -- has to be
        // written now, not just the entries row, or a later dedup-attach
        // in this same batch couldn't find it either.
        objectsRepo.upsert({
          hash,
          s3_key: existingKey,
          size: row.size!,
          ciphertext_checksum: null,
        });
        entriesRepo.upsert({ path: row.path, type: row.type, hash, state_version: versionStamp });
        progress.rowResolved();
        continue;
      }
    }

    const job: InFlightUpload = { sourceRows: [{ path: row.path, type: row.type }] };
    inFlightByHash.set(hash, job);

    // non-null: row.type === "file" (checked above) and this loop only ever
    // reaches this point for a non-deleted row (Pass 1 already consumed
    // every "deleted" row), and the DB's CHECK constraint (see
    // 0004_add_size.sql) guarantees size is NOT NULL for any such row.
    // Reading it here -- before dispatch -- is also what fixes this upload
    // path's own gap: size used to only be known *inside* the dispatched
    // job (a fresh fs.statSync there), after a whole batch might already be
    // in flight.
    const size = row.size!;
    progress.expectBytes(size);

    await waitForRoom(streamPool, streamQueueLimit);
    dispatchTracked(streamPool, streamPoolErrors, async () => {
      const absolutePath = path.join(root, row.path);
      const fileTracker = progress.startFile(row.path, size);
      try {
        const context = Buffer.from(hash, "hex");
        // Counted on the *plaintext* side, before encryptStream: those bytes
        // sum to exactly `size`, the denominator this file's tracker was
        // started with, whereas the ciphertext runs larger (a ~50-byte
        // header plus a tag per chunk) and would overrun the declared total.
        //
        // This necessarily leads the wire a little. Below
        // MULTIPART_THRESHOLD_BYTES the SDK buffers `requestStreamBufferSize`
        // ahead; above it, lib-storage's `Upload` stages roughly
        // queueSize * partSize before the first part is even sent. Accepted:
        // the alternative, `upload.on("httpUploadProgress")`, reports
        // encrypted bytes (wrong units again) and doesn't exist at all on
        // the single-PUT path, so it would buy accuracy for large files by
        // giving up on small ones entirely.
        const key = objectKey(hash);

        // Only the transfer itself -- withS3Retry's whole read-encrypt-PUT
        // -- is treated as a recoverable, leave-it-dirty-and-move-on
        // failure. Deliberately its own inner try/catch, not folded into
        // one big catch around this whole job: a failure in the DB writes
        // below (objectsRepo/entriesRepo) is a fundamentally different,
        // more serious problem -- evidence the candidate DB itself is
        // broken, not that one file's content didn't make it to S3 -- and
        // must not be silently swallowed the same way. Left to propagate
        // out of this whole dispatched job uncaught, it's exactly what the
        // stream pool's own error capture exists to catch properly.
        let ciphertextChecksum: string | undefined;
        let uploadSucceeded = false;
        try {
          // The retriable unit is the whole read-encrypt-PUT, not just the
          // PUT: a Readable that has already errored can't be replayed, so
          // each attempt opens a fresh one. The DB upserts below stay
          // outside it -- a retry re-sends bytes, it doesn't re-run
          // bookkeeping.
          //
          // A retried attempt re-reads from byte zero, so `onRetry` hands
          // the abandoned partial back via fileTracker.retrying(): the bar
          // rewinds to the last state actually committed to S3, which is
          // exactly what the next attempt has to re-earn. Leaving it in
          // place would have the new attempt's advance() calls pile onto
          // bytes that no longer exist anywhere.
          await withS3Retry(
            async () => {
              const sourceStream = countingReadable(fs.createReadStream(absolutePath), (n) =>
                fileTracker.advance(n),
              );
              const encryptedStream = encryptStream(sourceStream, size, masterKey, context);
              ciphertextChecksum = await putObjectStream(
                s3.client,
                s3.bucket,
                remoteKey(s3.location, key),
                encryptedStream,
                encryptedSize(size, context.length),
              );
            },
            {
              onRetry: (notice) => {
                fileTracker.retrying(notice);
                logger.warn(
                  {
                    path: row.path,
                    attempt: notice.attempt,
                    delayMs: notice.delayMs,
                    err:
                      notice.error instanceof Error ? notice.error.message : String(notice.error),
                  },
                  "transient S3 failure while uploading -- retrying",
                );
              },
            },
          );
          uploadSucceeded = true;
        } catch (err) {
          // Deliberately NOT reported as applied: handledPaths/
          // appliedCount/entriesRepo are never touched below when this
          // flag stays false, so every row riding on this job -- the
          // dispatcher and every dedup attach alike -- stays dirty in
          // cache.db, exactly as if this run had never touched it.
          // abort() (not finish()) is what keeps the bar honest: this
          // file's bytes never actually reached S3, so they must not be
          // counted as transferred.
          //
          // Also removed from inFlightByHash here, not just on success:
          // the main loop can race ahead of this job settling (it awaits
          // waitForRoom between rows), so a later row sharing this hash
          // could otherwise attach to a job that has already failed and
          // will never revisit job.sourceRows again -- silently losing
          // that row instead of starting a fresh upload attempt for it.
          fileTracker.abort();
          inFlightByHash.delete(hash);
          // Swallowed here, deliberately: every row riding on this job
          // stays dirty (see above) and the run continues, rather than
          // the whole process dying on an unhandled rejection the way an
          // uncaught failure would -- letting a bulk sync lose every
          // OTHER file's progress over one bad one would be a worse
          // outcome than a clean per-file failure. Surfacing this
          // properly to the command's own exit code/output (today it's
          // silent beyond this log line) is the next fix, not this one --
          // this catch exists to make that fix safe to add, by
          // guaranteeing a swallowed failure can never be mistaken for a
          // success.
          logger.warn(
            {
              paths: job.sourceRows.map((r) => r.path),
              hash,
              err: err instanceof Error ? err.message : String(err),
            },
            "upload failed -- row(s) left dirty, will retry on the next sync",
          );
        }

        if (!uploadSucceeded) return;

        objectsRepo.upsert({
          hash,
          s3_key: key,
          size,
          ciphertext_checksum: ciphertextChecksum ?? null,
        });
        uploadedObjects++;
        // Every row riding on this job -- the one that dispatched it, plus
        // any dedup attach that arrived before it settled (job.sourceRows
        // can have grown since dispatch, above) -- is only now genuinely
        // applied: handledPaths/appliedCount are recorded here, at the
        // point of actual success, not back when the row was merely
        // decided. sourceRows[0] is always the row that dispatched this
        // job -- its own content upload, not a dedup hit -- everything
        // after it attached to a job someone else already started.
        for (let i = 0; i < job.sourceRows.length; i++) {
          const sourceRow = job.sourceRows[i]!;
          if (i > 0) dedupedObjects++;
          handledPaths.set(sourceRow.path, versionStamp);
          appliedCount++;
          entriesRepo.upsert({
            path: sourceRow.path,
            type: sourceRow.type,
            hash,
            state_version: versionStamp,
          });
        }
        inFlightByHash.delete(hash);
        // Success only, per FileTracker's own contract -- abort() above is
        // the failure counterpart, and the two are mutually exclusive.
        fileTracker.finish();
        logger.debug(
          { pool: "stream", inFlight: streamPool.pending, queued: streamPool.size },
          "completed",
        );
      } finally {
        // Unconditional regardless of outcome, matching filesDone's own
        // contract ("how far through the tree", not "how many
        // succeeded") -- every row riding on this job has settled either
        // way by the time this runs.
        for (let i = 0; i < job.sourceRows.length; i++) progress.rowResolved();
      }
    });
    // Logged after add(), not before -- add() synchronously starts the task
    // (if capacity allows) before returning, so this reflects occupancy
    // *including* the job just dispatched.
    logger.debug(
      { pool: "stream", inFlight: streamPool.pending, queued: streamPool.size },
      "dispatched",
    );
  }

  await streamPool.onIdle();
  throwIfPoolErrored(streamPoolErrors);
  // Drops the estimate back onto what actually happened: a row that turned
  // out to conflict was counted as bytes up front (conflict detection needs
  // the candidate's entries table, which the offline count deliberately
  // doesn't consult), so without this the bar would stop short of 100%.
  progress.settle();

  return { uploadedObjects, dedupedObjects, handledPaths, appliedCount, conflicts };
}
