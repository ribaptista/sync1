import fs from "node:fs";
import type { Readable } from "node:stream";
import path from "node:path";
import type Database from "better-sqlite3";
import type PQueue from "p-queue";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";
import type { CacheEntryRow } from "../db/repositories/cache-entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { EntriesRepository } from "../db/repositories/entries-repository.js";
import { VersionsRepository } from "../db/repositories/versions-repository.js";
import { StoragePoliciesRepository } from "../db/repositories/storage-policies-repository.js";
import { encryptStream, encryptedSize } from "../crypto/streaming-codec.js";
import { HASH_BYTES } from "../crypto/hash.js";
import { headObject } from "../s3/client.js";
import { uploadObjectStream, S3UploadFatalError } from "../s3/upload-object.js";
import { resolveHashTargetClass } from "../s3/policy-evaluation.js";
import { remoteKey, objectKey, type RemoteLocation } from "../vault/paths.js";
import { decideLocalChange } from "./conflict-rules.js";
import { toCollisionKey } from "../fs/case-collision.js";
import { countingReadable } from "../fs/counting-stream.js";
import {
  mirrorObjectExists,
  writeMirrorStream,
  teeStream,
  withMirrorRetry,
  asMirrorWrite,
  MirrorWriteError,
  MirrorRequiredError,
} from "../fs/mirror-sink.js";
import { mirrorObjectPath } from "../vault/mirror-paths.js";
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
  /** Objects whose ciphertext was written to the mirror by this run. */
  mirroredObjects: number;
  /**
   * Objects committed to S3 that the mirror could not be given, only ever
   * non-zero under `onMaxRetries: "ignore"`. Informational: the run
   * succeeded, and `mirror catchup` closes the gap.
   */
  mirrorFailures: number;
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
  /**
   * One entry per path whose upload genuinely failed and was left dirty for
   * a later sync to retry -- a non-transient S3 error, a file that changed
   * since it was scanned, or (under `--on-mirror-max-retries ignore`) a
   * mirror write that failed on a unit whose S3 half never even completed.
   * Distinct from `conflicts`: a conflict is a human decision this run
   * correctly declined to make; a failure here is this run trying and not
   * succeeding, which used to be silent beyond a log line -- the swallow-
   * and-continue catch below was deliberately written to make adding this
   * safe, without letting a swallowed failure be mistaken for a success.
   */
  failed: Array<{ path: string; hash: string; error: string }>;
}

interface InFlightUpload {
  sourceRows: { path: string; type: CacheEntryRow["type"] }[];
}

/**
 * What to do when a mirror write has exhausted its retries.
 *
 * `fail` (the default) aborts the **whole run**, not just the one object
 * whose mirror write failed: `applyLocalChangesToCandidate` throws
 * `MirrorRequiredError`, which propagates uncaught all the way out, and
 * nothing this run touched is committed. This used to be a per-object
 * failure -- the object stayed dirty, but everything else in the batch
 * still committed -- which meant a local rename (a delete paired with a
 * create sharing the same content) could split in half: the delete
 * landing while the create's mirror-only write failed and stayed dirty,
 * leaving the content referenced by nothing the vault still tracks, ripe
 * for `gc` to remove it outright. Aborting the whole run instead means
 * nothing reaches the vault without reaching both copies, full stop --
 * the mirror can never silently drift behind S3, and a change that
 * belongs together commits together or not at all.
 *
 * `ignore` commits to S3 anyway and leaves the mirror short by a counted,
 * warned-about amount for `mirror catchup` to fill in later -- free, since
 * convergent encryption reproduces the same bytes from local plaintext. It
 * keeps backups progressing while the drive is detached, at the cost of
 * committed-but-unmirrored objects being a normal state. That is precisely
 * what `stubify`'s mirror gate exists to catch: under `fail` an unmirrored
 * file could never be stubbed anyway (its row never reaches `unchanged`),
 * so the gate only becomes load-bearing here.
 */
export type OnMirrorMaxRetries = "fail" | "ignore";

export interface MirrorOptions {
  /** Absolute path to the mirror, or undefined for no mirror at all. */
  path: string | undefined;
  onMaxRetries: OnMirrorMaxRetries;
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
  mirror: MirrorOptions = { path: undefined, onMaxRetries: "fail" },
  /**
   * Where `verifyRemote`'s HEAD checks are dispatched -- a metadata-only
   * call, cheap enough to deserve its own, typically much higher,
   * concurrency limit than the upload pool (`--s3-metadata-parallelism`,
   * the same pool `converge`/`status`/`sanity_check` use). Optional and
   * defaulting to `streamPool` itself: a caller that doesn't pass one
   * (every existing test, today) still gets correct behavior, just with
   * the HEAD checks and the uploads they occasionally escalate to sharing
   * one concurrency budget instead of two.
   */
  metadataPool: PQueue = streamPool,
  metadataQueueLimit: number = streamQueueLimit,
): Promise<ApplyLocalChangesResult> {
  const objectsRepo = new ObjectsRepository(candidateDb);
  const entriesRepo = new EntriesRepository(candidateDb);
  const versionsRepo = new VersionsRepository(candidateDb);
  // Loaded once for the whole run, not per row: a many-small-files sync
  // would otherwise pay for the same two small, unchanging queries on
  // every single dispatch. Used only to pick a genuinely new upload's
  // storage class up front (see the dispatch below) -- `converge` remains
  // the authority for correcting it later, for shared content another
  // path's own policy disagrees with, or for a policy edited after the
  // fact.
  const storagePoliciesRepo = new StoragePoliciesRepository(candidateDb);
  const nonDefaultPolicies = storagePoliciesRepo.listNonDefaultByPriority();
  const defaultPolicy = storagePoliciesRepo.getDefault();

  // Must exist before any entries row can reference it (entries.state_version
  // is a foreign key into versions.version_stamp) -- even if it turns out no
  // row ends up referencing it (all conflicts), the caller discards this
  // whole candidate db in that case, so an unused version row is harmless.
  versionsRepo.insert(versionStamp, new Date().toISOString());

  let uploadedObjects = 0;
  let mirroredObjects = 0;
  let mirrorFailures = 0;
  let dedupedObjects = 0;
  let appliedCount = 0;
  const handledPaths = new Map<string, string | null>();
  const conflicts: Array<{ path: string; reason: string }> = [];
  const failed: Array<{ path: string; hash: string; error: string }> = [];

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
  // this is what turns that into a real, catchable error instead. Two
  // boxes, one per pool, since either can fail independently -- same
  // reason materialize.ts (src/fs/materialize.ts) keeps its own s3Pool
  // and streamPool errors apart.
  const streamPoolErrors = createPoolErrorBox();
  const metadataPoolErrors = createPoolErrorBox();
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
        // `decideDeleted`'s own "apply" branch is only ever reached when
        // `existingEntry` is truthy (its `!existingEntry` case returns
        // "noop" instead) -- see src/sync/conflict-rules.ts.
        entriesRepo.deleteWithHistory(existingEntry!, versionStamp);
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
    // A dispatched job records an uncaught error into streamPoolErrors only
    // when it's fatal to the whole run (today: MirrorRequiredError under
    // `fail`, S3UploadFatalError, or an unexpected candidate-DB write
    // failure) -- an ordinary per-object upload/mirror failure is caught
    // and swallowed inside the job itself (see the dispatch below), never
    // reaching this box at all. metadataPoolErrors is the same idea for an
    // uncaught HEAD-check failure (see the verifyRemote dispatch below).
    // Once either has landed, the run is already doomed to abort at
    // throwIfPoolErrored() below; there's no reason to keep feeding either
    // pool more rows (more uploads/HEAD-checks for a candidate that will
    // never be committed) in the meantime.
    if (streamPoolErrors.hasError || metadataPoolErrors.hasError) break;

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

    // Where one question used to decide everything, there are now two:
    // "does S3 have it" and "does the mirror have it" are independent, and
    // a skip requires both. Mirroring only the upload path would leave a
    // hole for every deduped object -- silently, since from sync's point
    // of view those rows succeeded.
    const mirrorObjectTarget =
      mirror.path === undefined ? undefined : mirrorObjectPath(mirror.path, hash);
    const mirrorNeedsObject =
      mirrorObjectTarget !== undefined &&
      !mirrorObjectExists(mirrorObjectTarget, encryptedSize(row.size!, HASH_BYTES));

    if (objectsRepo.has(hash) && !mirrorNeedsObject) {
      dedupedObjects++;
      handledPaths.set(row.path, versionStamp);
      appliedCount++;
      logger.debug({ path: row.path, hash }, "content already known, skipping upload (dedup)");
      entriesRepo.upsert({ path: row.path, type: row.type, hash, state_version: versionStamp });
      progress.rowResolved();
      continue;
    }
    // Known to S3 but absent from the mirror: no upload, but the bytes
    // still have to be produced locally. Handled by the dispatch below,
    // which writes only the sinks that are missing.
    const alreadyOnS3 = objectsRepo.has(hash);

    // Claimed *before* any async work starts -- including the verifyRemote
    // HEAD check below, which now runs concurrently with other rows' own
    // HEAD checks rather than one at a time. A same-batch row sharing this
    // hash that arrives while either the HEAD check or the upload itself is
    // still in flight finds this job already here and attaches to it
    // (below), rather than racing it: two rows reaching the
    // `inFlightByHash.get(hash)` check above before either had recorded
    // itself here would otherwise both decide "not in flight" and both pay
    // for their own HEAD check and, if S3 doesn't have it yet, their own
    // separate upload of identical bytes.
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

    // Resolved from this one dispatching path, not re-evaluated per
    // dedup attach that rides on the same job afterward -- a same-batch
    // attach whose own path implies a warmer class than the row that
    // actually dispatched the upload can't change a class already in
    // flight. `converge`, not this decision, is what a shared object's
    // warmest-wins policy ultimately has to enforce.
    const { targetClass } = resolveHashTargetClass([row.path], nonDefaultPolicies, defaultPolicy);

    // The actual read-encrypt-write, extracted so it can be invoked from
    // either branch below with whatever `remoteChecksum` that branch has in
    // hand: `undefined` when verifyRemote never ran or found nothing, the
    // HEAD's own value when it did.
    const runUploadJob = async (remoteChecksum: string | undefined): Promise<void> => {
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

        // Only the transfer itself is treated as a recoverable,
        // leave-it-dirty-and-move-on failure -- EXCEPT a non-transient S3
        // error, which is fatal to the whole run (see `S3UploadFatalError`,
        // src/s3/upload-object.ts). Deliberately its own inner try/catch,
        // not folded into one big catch around this whole job: a failure
        // in the DB writes below (objectsRepo/entriesRepo) is a
        // fundamentally different, more serious problem -- evidence the
        // candidate DB itself is broken, not that one file's content
        // didn't make it to S3 -- and must not be silently swallowed the
        // same way. Left to propagate out of this whole dispatched job
        // uncaught, it's exactly what the stream pool's own error capture
        // exists to catch properly.
        // The checksum doubles as the success flag: `uploadObjectStream`
        // resolves only once S3's own CRC64NVME matched the client's, so a
        // value here *is* proof the upload landed and was verified, and a
        // separate boolean could only ever disagree with it. That also
        // makes the non-null requirement 0011 added a type-level fact
        // rather than a `?? null` fallback at the upsert below.
        let ciphertextChecksum: string | undefined;
        // Which sinks this object still needs. `needsS3` is false exactly
        // when the object is already remote but absent from the mirror --
        // the case that would have been a silent hole if mirroring hung
        // off the upload path alone.
        const needsS3 = !alreadyOnS3 && remoteChecksum === undefined;
        // When S3 already holds the object, the checksum comes from
        // whichever source established that -- the existing row, or the
        // HEAD that found it. Seeding it here keeps the bookkeeping below
        // keyed on one thing ("do we have a verified checksum?") rather
        // than branching on which sink ran.
        if (!needsS3) {
          ciphertextChecksum = remoteChecksum ?? objectsRepo.get(hash)?.ciphertext_checksum;
        }
        const mirrorTarget = mirrorNeedsObject ? mirrorObjectTarget : undefined;
        let wroteMirror = false;
        try {
          // The retriable unit is the whole read-encrypt-write, not just
          // one request: a Readable that has already errored can't be
          // replayed, so each attempt opens a fresh one. The DB upserts
          // below stay outside it -- a retry re-sends bytes, it doesn't
          // re-run bookkeeping. Only `withMirrorRetry` wraps this now --
          // S3's own transient failures are retried per-request/per-part
          // *inside* `uploadObjectStream`, so they never need the whole
          // file re-read and re-encrypted from byte zero the way they used
          // to.
          const runUnit = async (): Promise<void> => {
            // Cheap guard ahead of the expensive one. `hash` and `size`
            // both come from the cache row written back in the scanning
            // phase, while the bytes below are read now -- hours later on
            // a large vault. A stat costs one syscall and rejects any
            // edit that moved mtime or size *before* a single byte goes
            // out, where encryptStream's hash check can only reject after
            // the body is already in flight. Neither subsumes the other:
            // this misses a size- and mtime-preserving edit, which is
            // exactly the silent case the hash catches.
            const current = fs.statSync(absolutePath);
            // Rounded to match how the cache stores it (see
            // `Math.round(fsEntry.mtimeMs)` in update-cache.ts) -- an
            // unrounded comparison would report a spurious change on any
            // filesystem with sub-millisecond timestamps.
            const currentMtime = Math.round(current.mtimeMs);
            if (current.size !== size || currentMtime !== row.mtime) {
              throw new Error(
                `"${row.path}" changed since it was scanned (size ${size} -> ${current.size}, mtime ${row.mtime} -> ${currentMtime}) -- leaving it dirty for the next sync rather than storing it under a stale hash`,
              );
            }

            // Shared by every sink this attempt touches, so that whichever
            // one gives up for good stops the others wherever they are --
            // instead of each stream reaching that conclusion on its own,
            // if it ever does, the way the tee alone used to have to. The
            // source read is included: without it, an upload that aborted
            // because the mirror failed would leave the file handle open,
            // paused, for nothing left to read it.
            const controller = new AbortController();
            const signal = controller.signal;
            let firstFailure: { source: "s3" | "mirror"; error: unknown } | undefined;
            // Every failed sink is logged here, the instant it happens --
            // not only the one that ultimately decides the attempt's
            // outcome -- so a hang-shaped failure (the mirror never
            // settling) can no longer hide the fact that the S3 side
            // already failed minutes earlier. `!signal.aborted` is what
            // makes the *first* failure the one that decides: aborting is
            // synchronous, so whichever rejection is observed first sets
            // it, and every later one -- including the echo the abort
            // itself causes in the other sink -- finds the signal already
            // aborted and is logged only, never promoted to the cause.
            const recordFailure = (source: "s3" | "mirror", error: unknown): void => {
              logger.warn(
                {
                  path: row.path,
                  hash,
                  source,
                  err: error instanceof Error ? error.message : String(error),
                },
                "sink failed during upload attempt",
              );
              if (signal.aborted) return;
              firstFailure = { source, error };
              controller.abort(error);
            };

            const sourceStream = countingReadable(fs.createReadStream(absolutePath), (n) =>
              fileTracker.advance(n),
            );
            // `expectedHash` is `hash` itself: for a content object the
            // context *is* the content hash, so this asks the codec to
            // prove the bytes it is encrypting are the ones that hash
            // was taken from. See EncryptStreamOptions for why the two
            // can disagree, and why a mismatch has to abort the stream
            // rather than be reported afterwards.
            const encryptedStream = encryptStream(sourceStream, size, masterKey, context, {
              expectedHash: hash,
              signal,
            });
            // Observed, never consumed: `uploadObjectStream` has no way to
            // tell "my own S3 call failed" from "the body stream I was
            // handed failed" -- a read error (a permission change, a
            // yanked drive) or a hash mismatch surfaces to it identically,
            // as a rejected read. Listening here, directly on the one
            // stream every sink's body is derived from, is what lets this
            // attempt tell the two apart and route each correctly: an
            // upstream failure stays a per-row "leave dirty" case, not an
            // `S3UploadFatalError` that would wrongly abort the whole run
            // over a problem S3 was never involved in.
            //
            // No `controller.abort()` here, deliberately: the stream
            // failing already fails the upload on its own -- the
            // producer's own `readExact` rejects with this same error,
            // which is what reaches `uploadObjectStream`'s catch and
            // aborts the multipart upload. Calling `abort()` too would
            // only cancel whichever `UploadPart` requests happened to
            // still be in flight a little sooner; it changes nothing
            // observable, so it isn't worth the extra mechanism.
            let upstreamError: unknown;
            encryptedStream.once("error", (err: unknown) => {
              upstreamError ??= err;
            });
            const uploadTo = async (stream: Readable): Promise<void> => {
              ciphertextChecksum = await uploadObjectStream(
                s3.client,
                s3.bucket,
                remoteKey(s3.location, key),
                stream,
                encryptedSize(size, context.length),
                targetClass,
                {
                  signal,
                  logger,
                  onRetry: (notice) => {
                    fileTracker.retrying(notice);
                    logger.warn(
                      {
                        path: row.path,
                        hash,
                        part: notice.part,
                        attempt: notice.attempt,
                        delayMs: notice.delayMs,
                        err:
                          notice.error instanceof Error
                            ? notice.error.message
                            : String(notice.error),
                      },
                      "transient S3 failure while uploading -- retrying",
                    );
                  },
                },
              );
            };
            const mirrorTo = async (stream: Readable): Promise<void> => {
              await asMirrorWrite(mirrorTarget!, () =>
                writeMirrorStream(mirrorTarget!, stream, { signal }),
              );
              wroteMirror = true;
            };

            if (needsS3 && mirrorTarget !== undefined) {
              // One read, one encryption, two sinks advancing in
              // lockstep. S3 therefore goes no faster than the mirror --
              // accepted deliberately, in exchange for a clean sync
              // meaning a complete mirror with no reconciliation pass.
              //
              // The tee's own failure mode has to match what this
              // attempt intends to do with a mirror failure: `ignore`
              // wants S3 to finish regardless (`detach-secondary`),
              // `fail` wants the whole object abandoned together
              // (`abort-both`, the default). This is the one place that
              // decision actually gets made -- passing nothing here
              // silently defaults to `abort-both` for both modes,
              // which used to be exactly what happened. The tee's own
              // early-close detection (src/fs/mirror-sink.ts) stays as a
              // safety net for whatever doesn't honor `signal` directly;
              // the controller above is now the primary mechanism.
              const { primary, secondary } = teeStream(
                encryptedStream,
                mirror.onMaxRetries === "ignore" ? "detach-secondary" : "abort-both",
              );
              // `Promise.all`, not `allSettled`, would reject the
              // instant *either* promise does -- abandoning whichever
              // one is still running rather than waiting for it. For a
              // still-running `uploadTo` that is exactly the danger:
              // its underlying PUT keeps executing in the background
              // regardless, and would go on to set `ciphertextChecksum`
              // whenever it eventually resolved -- including after
              // `withMirrorRetry` had already decided this attempt
              // failed and started a fresh one, so a stale, abandoned
              // attempt's success could silently leak into a *later*
              // attempt's bookkeeping. Waiting for both to settle here,
              // every time, is what keeps each attempt's outcome fully
              // its own.
              const [uploadOutcome, mirrorOutcome] = await Promise.allSettled([
                uploadTo(primary),
                mirrorTo(secondary),
              ]);
              if (uploadOutcome.status === "rejected") {
                recordFailure("s3", uploadOutcome.reason);
              }
              if (mirrorOutcome.status === "rejected") {
                recordFailure("mirror", mirrorOutcome.reason);
              }
              // Checked ahead of both sinks' own classification: the tee
              // destroys *both* branches with the identical error the
              // moment the source itself fails, so whichever of
              // `uploadTo`/`mirrorTo` happened to settle (and call
              // `recordFailure`) first would otherwise mislabel a read
              // failure or hash mismatch as that sink's own fault.
              if (upstreamError !== undefined) throw upstreamError;
              if (firstFailure?.source === "mirror") throw firstFailure.error;
              if (firstFailure?.source === "s3") {
                throw new S3UploadFatalError(
                  job.sourceRows.map((r) => r.path),
                  hash,
                  firstFailure.error,
                );
              }
            } else if (needsS3) {
              try {
                await uploadTo(encryptedStream);
              } catch (err) {
                // Same ordering as the branch above: a failure that
                // originated upstream of `uploadObjectStream` (a read
                // error, a hash mismatch) is this row's own problem to
                // leave dirty, not evidence S3 did anything wrong --
                // `uploadObjectStream` has no way to tell the two apart
                // itself, since both arrive as an ordinary rejected read.
                if (upstreamError !== undefined) throw upstreamError;
                // No mirror in this attempt to coordinate with, but the
                // same rule from the branch above still applies: a
                // non-transient S3 error is fatal to the whole run, not a
                // per-object failure this row can just stay dirty over.
                throw new S3UploadFatalError(
                  job.sourceRows.map((r) => r.path),
                  hash,
                  err,
                );
              }
            } else if (mirrorTarget !== undefined) {
              // S3 already holds these exact bytes (a dedup hit, or a
              // verifyRemote HEAD): only the mirror is missing, so no
              // upload is paid for at all.
              await mirrorTo(encryptedStream);
            } else {
              // Reachable only on the `ignore` fallback pass for an
              // object S3 already had: both sinks are now satisfied or
              // given up on, so there is nothing left to stream. The
              // source still has to be drained, or the file handle and
              // the progress tracker are both left dangling.
              encryptedStream.destroy();
            }
          };

          try {
            await withMirrorRetry(runUnit);
          } catch (err) {
            if (err instanceof S3UploadFatalError) throw err;
            if (!(err instanceof MirrorWriteError)) throw err;
            if (mirror.onMaxRetries === "fail") {
              // Escalate, deliberately: this is not a per-object failure
              // this row can just stay dirty over. Under `fail`, nothing
              // in this batch may commit without every mirror write
              // succeeding, so the whole run has to abort -- thrown here,
              // uncaught by the swallow-and-continue catch just below,
              // so it reaches dispatchTracked's error box and, from
              // there, throwIfPoolErrored() once every already-dispatched
              // job has settled.
              throw new MirrorRequiredError(
                job.sourceRows.map((r) => r.path),
                hash,
                err,
              );
            }
            // `ignore`: the sync progresses without the second copy.
            //
            // Nothing is re-run. Because the tee detached rather than
            // aborting, the upload this same attempt started went on to
            // complete -- so the object is already on S3, verified, with
            // its checksum in hand. There is no retry to attempt either:
            // a one-shot stream cannot be replayed mid-flight, and the
            // bytes are long gone. `mirror catchup` closes the gap later
            // from local plaintext, free, because encryption is
            // convergent.
            if (ciphertextChecksum === undefined) throw err;
            mirrorFailures++;
            logger.warn(
              {
                paths: job.sourceRows.map((r) => r.path),
                hash,
                target: err.target,
                err: err.cause instanceof Error ? err.cause.message : String(err.cause),
              },
              "mirror write failed -- the object is committed to S3, run `sync1 mirror catchup` to close the gap",
            );
          }
        } catch (err) {
          // MirrorRequiredError and S3UploadFatalError are not per-object
          // failures -- see their own doc comments (src/fs/mirror-sink.ts,
          // src/s3/upload-object.ts) and OnMirrorMaxRetries above.
          // Rethrown here, uncaught, deliberately ahead of every other
          // branch below: none of this job's own bookkeeping matters once
          // the whole run is aborting, and rethrowing is what lets
          // dispatchTracked capture it into streamPoolErrors instead of
          // this catch swallowing it the way an ordinary upload failure
          // is swallowed just below.
          if (err instanceof MirrorRequiredError || err instanceof S3UploadFatalError) throw err;

          // Deliberately NOT reported as applied: handledPaths/
          // appliedCount/entriesRepo are never touched below when this
          // flag stays false, so every row riding on this job -- the
          // dispatcher and every dedup attach alike -- stays dirty in
          // cache.db, exactly as if this run had never touched it.
          //
          // That guarantee rests entirely on `ciphertextChecksum` staying
          // `undefined` here, and it is NOT automatically true: with a
          // mirror configured, a retry attempt's S3 upload can succeed in
          // full -- setting the checksum -- and the *mirror* half can
          // still be what ultimately fails this whole unit (`fail` mode
          // discarding a real success on principle; or a mirror error
          // whose failure never engaged the tee's abort/detach logic at
          // all, e.g. a synchronous pre-write error like `mkdirSync`
          // throwing before either stream starts flowing, so a perfectly
          // healthy S3 side completes independently regardless of mode).
          // A checksum set by an attempt this catch is discarding must not
          // survive into the commit below, or the object gets recorded as
          // uploaded despite every row riding on it being told it wasn't.
          ciphertextChecksum = undefined;
          wroteMirror = false;
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
          // outcome than a clean per-file failure. Recorded into `failed`
          // (one entry per row riding on this job, not just the
          // dispatcher) precisely so it stops being silent beyond this log
          // line -- the caller decides what that means for the run's own
          // exit code and summary, this function's job is only to make
          // sure a swallowed failure can never be mistaken for a success.
          const errorMessage = err instanceof Error ? err.message : String(err);
          for (const sourceRow of job.sourceRows) {
            failed.push({ path: sourceRow.path, hash, error: errorMessage });
          }
          logger.warn(
            {
              paths: job.sourceRows.map((r) => r.path),
              hash,
              err: errorMessage,
            },
            "upload failed -- row(s) left dirty, will retry on the next sync",
          );
        }

        if (ciphertextChecksum === undefined) return;

        if (wroteMirror) mirroredObjects++;
        objectsRepo.upsert({
          hash,
          s3_key: key,
          size,
          ciphertext_checksum: ciphertextChecksum,
        });
        // Only a real transfer counts. A mirror-only pass moved no bytes
        // to S3, so reporting it as uploaded would overstate what the run
        // actually sent -- it is a dedup hit that happened to owe the
        // mirror a copy.
        if (needsS3) uploadedObjects++;
        else dedupedObjects++;
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
    };

    if (verifyRemote && !alreadyOnS3) {
      // Not known to *this* candidate, but a prior run's upload could
      // still have reached S3 before it got aborted -- object records
      // only ever live in whatever candidate DB that run was using,
      // discarded along with everything else it never got to promote. A
      // HEAD is a sound existence check here specifically because the key
      // is content-addressed and encryption is convergent: present can
      // only mean this exact plaintext, encrypted the exact same way,
      // already made it.
      //
      // Dispatched to its own pool (`metadataPool`, bounded by
      // `--s3-metadata-parallelism`), separate from the upload pool below:
      // a HEAD is metadata-only and cheap, so it deserves its own,
      // typically much higher, concurrency limit -- nested dispatch, the
      // same pattern materialize's own classify-then-maybe-download ladder
      // uses (src/fs/materialize.ts). This also closes the hole the old,
      // awaited-inline version of this check left open: with only one HEAD
      // ever in flight at a time, this whole phase ran at a single
      // connection's pace regardless of `--s3-metadata-parallelism`.
      await waitForRoom(metadataPool, metadataQueueLimit);
      dispatchTracked(metadataPool, metadataPoolErrors, async () => {
        const existingKey = objectKey(hash);
        // Not wrapped in withS3Retry, deliberately unchanged from before
        // this function went concurrent: an uncaught failure here lands in
        // metadataPoolErrors exactly like an uncaught failure from the old
        // inline `await` propagated straight out of the whole function --
        // fatal to the run, not a per-row "leave dirty" case. A transient
        // HEAD failure during recovery was already treated this harshly;
        // this preserves that rather than quietly softening it.
        const head = await headObject(s3.client, s3.bucket, remoteKey(s3.location, existingKey));
        // A checksum is part of the shortcut's price, not a bonus. Taking it
        // writes the only `objects` row this hash will ever get -- every
        // later run hits the objectsRepo.has() branch above and never
        // re-upserts -- so a checksum missing here would be missing forever,
        // and 0011 requires one. Rather than fail the run or invent a value,
        // decline the shortcut and let the normal upload path below produce
        // a properly corroborated one. Costs one re-upload of an object that
        // is already there, self-heals permanently, and can now only happen
        // for an object predating the checksum column at all.
        if (head && !head.checksumCrc64Nvme) {
          logger.debug(
            { path: row.path, hash },
            "content present in S3 but with no recorded checksum -- re-uploading rather than adopting an unverified object",
          );
        }
        // Recorded even when the mirror still needs the object: S3 is
        // demonstrably holding the right bytes, so escalating to
        // runUploadJob below (if it comes to that) has only the mirror
        // left to write.
        const remoteChecksum = head?.checksumCrc64Nvme;
        if (remoteChecksum && !mirrorNeedsObject) {
          // Every row riding on this job -- the dispatcher, plus any
          // dedup attach that arrived while this HEAD was still in flight
          // (job.sourceRows can have grown since dispatch, exactly like
          // runUploadJob's own success path handles for an upload) -- is a
          // dedup hit: S3 already has these bytes and the mirror doesn't
          // need them either, so nothing further has to run for any of
          // them.
          //
          // Unlike the objectsRepo.has(hash) branch above, this candidate
          // never had an objects row for this hash at all -- has to be
          // written now, not just the entries row, or a later dedup-attach
          // in this same batch couldn't find it either.
          //
          // The checksum comes from the HEAD above, and is trustworthy for
          // a specific reason: an object only reached S3 through
          // `uploadObjectStream`, which refuses to return without S3's own
          // value matching the client's. So S3's stored number was already
          // corroborated -- by the very run that crashed before recording
          // it. Adopting it here is reading back a proof, not assuming one.
          objectsRepo.upsert({
            hash,
            s3_key: existingKey,
            size,
            ciphertext_checksum: remoteChecksum,
          });
          for (const sourceRow of job.sourceRows) {
            dedupedObjects++;
            handledPaths.set(sourceRow.path, versionStamp);
            appliedCount++;
            entriesRepo.upsert({
              path: sourceRow.path,
              type: sourceRow.type,
              hash,
              state_version: versionStamp,
            });
          }
          logger.debug(
            { paths: job.sourceRows.map((r) => r.path), hash },
            "content already present in S3 from a prior aborted run -- skipping re-upload (verify-remote)",
          );
          inFlightByHash.delete(hash);
          for (let i = 0; i < job.sourceRows.length; i++) progress.rowResolved();
          return;
        }
        // Either S3 doesn't have it, or it does but with no recorded
        // checksum (declining the shortcut) -- either way, a real
        // read-encrypt-write is still needed (for the mirror alone, if
        // `remoteChecksum` ended up set; for both sinks otherwise).
        // Escalated into the heavier, lower-concurrency upload pool only
        // now that that's known -- not every HEAD check needs to occupy
        // one of its slots.
        await waitForRoom(streamPool, streamQueueLimit);
        dispatchTracked(streamPool, streamPoolErrors, () => runUploadJob(remoteChecksum));
        logger.debug(
          { pool: "stream", inFlight: streamPool.pending, queued: streamPool.size },
          "dispatched (from HEAD check)",
        );
      });
      logger.debug(
        { pool: "s3-metadata", inFlight: metadataPool.pending, queued: metadataPool.size },
        "dispatched",
      );
    } else {
      await waitForRoom(streamPool, streamQueueLimit);
      dispatchTracked(streamPool, streamPoolErrors, () => runUploadJob(undefined));
      // Logged after add(), not before -- add() synchronously starts the task
      // (if capacity allows) before returning, so this reflects occupancy
      // *including* the job just dispatched.
      logger.debug(
        { pool: "stream", inFlight: streamPool.pending, queued: streamPool.size },
        "dispatched",
      );
    }
  }

  // metadataPool drained *before* streamPool, not just alongside it: by
  // the time every HEAD-check job has settled, every upload it might have
  // triggered has already been enqueued into streamPool (the same
  // ordering materialize.ts uses between its own s3Pool and streamPool,
  // for the same reason). Draining streamPool first could otherwise go
  // idle while a HEAD check was still about to escalate into it.
  await metadataPool.onIdle();
  throwIfPoolErrored(metadataPoolErrors);
  await streamPool.onIdle();
  throwIfPoolErrored(streamPoolErrors);
  // Drops the estimate back onto what actually happened: a row that turned
  // out to conflict was counted as bytes up front (conflict detection needs
  // the candidate's entries table, which the offline count deliberately
  // doesn't consult), so without this the bar would stop short of 100%.
  progress.settle();

  return {
    uploadedObjects,
    dedupedObjects,
    mirroredObjects,
    mirrorFailures,
    handledPaths,
    appliedCount,
    conflicts,
    failed,
  };
}
