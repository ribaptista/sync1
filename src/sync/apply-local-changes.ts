import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";
import type { CacheEntryRow } from "../db/repositories/cache-entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { EntriesRepository } from "../db/repositories/entries-repository.js";
import { VersionsRepository } from "../db/repositories/versions-repository.js";
import { encryptStream, encryptedSize } from "../crypto/streaming-codec.js";
import { putObjectStream } from "../s3/client.js";
import { remoteKey, objectKey, type RemoteLocation } from "../vault/paths.js";
import { decideLocalChange } from "./conflict-rules.js";
import { toCollisionKey } from "../fs/case-collision.js";

export interface ApplyLocalChangesResult {
  uploadedObjects: number;
  dedupedObjects: number;
  /** rows successfully applied or resolved as no-ops -- safe to reconcile to 'unchanged' */
  handledPaths: Set<string>;
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

/**
 * Folds a snapshot of cache.db's dirty rows into the candidate state.db,
 * applying the create/modified/deleted conflict matrix (src/sync/
 * conflict-rules.ts) against whatever entry currently exists there. Any not-
 * yet-known object content is uploaded (checking `objects` for the hash is
 * the dedup check) before the entry that references it is written -- never
 * the other way around, so a crash never leaves a dangling reference.
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
  const handledPaths = new Set<string>();
  const conflicts: Array<{ path: string; reason: string }> = [];

  for (const row of dirtyRows) {
    const existingEntry = entriesRepo.get(row.path);

    // Only a genuinely new path can newly collide -- "modified"/"deleted"
    // target a path that already exists, so decideLocalChange's own
    // exact-path matching already handles those (e.g. "modified locally,
    // deleted remotely" conflicts regardless of casing). An exact-path
    // lookup like `existingEntry` above can't see a *different*-cased
    // entry, which is exactly the gap this check closes: without it, a
    // local create colliding with an already-remote-committed case
    // variant would be folded into the candidate and permanently
    // committed. See docs/architecture/cross-platform-filesystem.md.
    if (row.state === "created") {
      const collision = entriesRepo.findByNormalizedPath(toCollisionKey(row.path), row.path);
      if (collision) {
        const reason = `case-insensitive collision with existing entry "${collision.path}" -- rename or remove one of them and sync again`;
        conflicts.push({ path: row.path, reason });
        logger.debug(
          { path: row.path, collidesWith: collision.path },
          "case-insensitive collision, skipping",
        );
        continue;
      }
    }

    const decision = decideLocalChange(row, existingEntry);

    if (decision.kind === "conflict") {
      conflicts.push({ path: row.path, reason: decision.reason });
      logger.debug({ path: row.path, reason: decision.reason }, "local change conflicts, skipping");
      continue;
    }

    handledPaths.add(row.path);

    if (decision.kind === "noop") {
      logger.debug({ path: row.path }, "local change already reconciled remotely (no-op)");
      continue;
    }

    // decision.kind === "apply"
    appliedCount++;

    if (row.state === "deleted") {
      entriesRepo.delete(row.path);
      logger.debug({ path: row.path }, "removing entry (deleted locally)");
      continue;
    }

    let hash: string | null = null;
    if (row.type === "file") {
      if (!row.hash) {
        throw new Error(`cache row for "${row.path}" is a file with no recorded hash`);
      }
      hash = row.hash;

      if (objectsRepo.has(hash)) {
        dedupedObjects++;
        logger.debug({ path: row.path, hash }, "content already known, skipping upload (dedup)");
      } else {
        const absolutePath = path.join(root, row.path);
        const context = Buffer.from(hash, "hex");
        const size = fs.statSync(absolutePath).size;
        const sourceStream = fs.createReadStream(absolutePath);
        const encryptedStream = encryptStream(sourceStream, size, masterKey, context);
        const key = objectKey(hash);
        await putObjectStream(
          s3.client,
          s3.bucket,
          remoteKey(s3.location, key),
          encryptedStream,
          encryptedSize(size, context.length),
        );
        objectsRepo.upsert({ hash, s3_key: key, size });
        uploadedObjects++;
        logger.debug({ path: row.path, hash, size }, "uploaded new object");
      }
    }

    entriesRepo.upsert({ path: row.path, type: row.type, hash, state_version: versionStamp });
  }

  return { uploadedObjects, dedupedObjects, handledPaths, appliedCount, conflicts };
}
