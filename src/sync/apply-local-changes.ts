import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";
import type { CacheEntryRow } from "../db/repositories/cache-entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { EntriesRepository } from "../db/repositories/entries-repository.js";
import { VersionsRepository } from "../db/repositories/versions-repository.js";
import { encryptBuffer } from "../crypto/chunked-codec.js";
import { putObject } from "../s3/client.js";
import { remoteKey, objectKey, type RemoteLocation } from "../vault/paths.js";

export interface ApplyLocalChangesResult {
  uploadedObjects: number;
  dedupedObjects: number;
  entriesChanged: number;
}

/**
 * Folds a snapshot of cache.db's dirty rows into the candidate state.db,
 * uploading any not-yet-known object content first (checking `objects` for
 * the hash is the dedup check) before writing the entry that references it
 * -- never the other way around, so a crash never leaves a dangling
 * reference to bytes that don't exist yet.
 *
 * This is the local-only half of the merge (Task 7 scope: single machine,
 * no conflicts). The full bidirectional conflict-resolution algebra is
 * layered on in Task 8.
 */
export async function applyLocalChangesToCandidate(
  candidateDb: Database.Database,
  dirtyRows: readonly CacheEntryRow[],
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
  // is a foreign key into versions.version_stamp).
  versionsRepo.insert(versionStamp, new Date().toISOString());

  let uploadedObjects = 0;
  let dedupedObjects = 0;

  for (const row of dirtyRows) {
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
        const plaintext = fs.readFileSync(absolutePath);
        const context = Buffer.from(hash, "hex");
        const encrypted = encryptBuffer(plaintext, masterKey, context);
        const key = objectKey(hash);
        await putObject(s3.client, s3.bucket, remoteKey(s3.location, key), encrypted);
        objectsRepo.upsert({ hash, s3_key: key, size: plaintext.length });
        uploadedObjects++;
        logger.debug({ path: row.path, hash, size: plaintext.length }, "uploaded new object");
      }
    }

    entriesRepo.upsert({ path: row.path, type: row.type, hash, state_version: versionStamp });
  }

  return { uploadedObjects, dedupedObjects, entriesChanged: dirtyRows.length };
}
