import fs from "node:fs";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";
import { openStateDb } from "../db/connection.js";
import { VersionsRepository } from "../db/repositories/versions-repository.js";
import { generateVersionStamp } from "../vault/version-stamp.js";
import { encryptBuffer, decryptBuffer, CryptoAuthError } from "../crypto/chunked-codec.js";
import { getObject, putObject, putObjectCas, CasConflictError } from "../s3/client.js";
import {
  remoteKey,
  stateSnapshotKey,
  CURRENT_POINTER_KEY,
  type RemoteLocation,
} from "../vault/paths.js";
import { localStateDbPath, lastSyncedVersionPath } from "../vault/local-dir.js";
import { CorruptionError } from "../errors.js";
import { tempSiblingPath } from "../fs/temp-path.js";
import { copyFileWithRetry } from "../fs/safe-fs.js";

const MAX_CAS_ATTEMPTS = 5;

export interface MutateStateDbResult<T> {
  versionStamp: string;
  result: T;
}

/**
 * Commits a small, state.db-only mutation (e.g. an ignore-policy or
 * storage-policy row) -- shared by both features rather than duplicated,
 * since the mechanism is identical: fetch `/current` fresh, decrypt its
 * snapshot, apply `mutate` to a candidate copy, bump the version, upload,
 * and CAS-retry against `/current`. Modeled directly on `gc.ts`'s
 * CAS-retry structure: a policy/ignore-rule edit has no human conflict to
 * resolve (unlike `sync`), so auto-retrying on a losing race is safe --
 * each attempt starts completely fresh from whatever `/current` now
 * points at, so `mutate` must be an idempotent, self-contained edit (e.g.
 * "insert this specific row"), safe to re-run against a fresh candidate
 * on every attempt.
 *
 * `onBeforeCas` is a test-only seam (mirroring `gc.ts`'s own): called
 * immediately before each CAS attempt, giving a test a deterministic point
 * to inject a competing commit and force a real retry, rather than relying
 * on real-world timing between two separate processes.
 */
export async function mutateStateDb<T>(
  root: string,
  masterKey: Buffer,
  s3: { client: S3Client; bucket: string; location: RemoteLocation },
  logger: Logger,
  mutate: (candidateDb: Database.Database) => T,
  onBeforeCas?: () => Promise<void>,
): Promise<MutateStateDbResult<T>> {
  const currentKey = remoteKey(s3.location, CURRENT_POINTER_KEY);

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const current = await getObject(s3.client, s3.bucket, currentKey);
    if (!current) throw new CorruptionError("vault has no /current pointer (corrupt vault?)");
    const versionStamp = current.body.toString("utf8");

    const snapshot = await getObject(
      s3.client,
      s3.bucket,
      remoteKey(s3.location, stateSnapshotKey(versionStamp)),
    );
    if (!snapshot) {
      throw new CorruptionError(`state.db snapshot for version "${versionStamp}" is missing`);
    }

    let decrypted: Buffer;
    try {
      decrypted = decryptBuffer(snapshot.body, masterKey);
    } catch (err) {
      if (err instanceof CryptoAuthError) {
        throw new CorruptionError("state.db snapshot failed decryption/authentication");
      }
      throw err;
    }

    const candidatePath = tempSiblingPath(localStateDbPath(root), "mutate-candidate");
    fs.writeFileSync(candidatePath, decrypted);

    try {
      const candidateDb = openStateDb(candidatePath, logger);
      try {
        const result = mutate(candidateDb);

        const newVersionStamp = generateVersionStamp();
        new VersionsRepository(candidateDb).insert(newVersionStamp, new Date().toISOString());

        // Checkpoint (rather than close) purely so the on-disk file
        // reflects every write before reading it back for upload -- the
        // candidate connection itself doesn't need to stay open past this
        // point (unlike gc.ts, nothing here needs it again afterward).
        candidateDb.pragma("wal_checkpoint(TRUNCATE)");
        candidateDb.close();

        const candidateBytes = fs.readFileSync(candidatePath);
        const context = randomBytes(16); // non-convergent: state.db isn't content-addressed
        const encrypted = encryptBuffer(candidateBytes, masterKey, context);
        await putObject(
          s3.client,
          s3.bucket,
          remoteKey(s3.location, stateSnapshotKey(newVersionStamp)),
          encrypted,
        );

        await onBeforeCas?.();

        try {
          await putObjectCas(
            s3.client,
            s3.bucket,
            currentKey,
            Buffer.from(newVersionStamp, "utf8"),
            { ifMatch: current.etag },
          );
        } catch (err) {
          if (err instanceof CasConflictError) {
            logger.debug({ attempt }, "mutateStateDb: CAS conflict, refetching and recomputing");
            continue;
          }
          throw err;
        }

        await copyFileWithRetry(candidatePath, localStateDbPath(root));
        fs.writeFileSync(lastSyncedVersionPath(root), newVersionStamp, "utf8");

        return { versionStamp: newVersionStamp, result };
      } finally {
        if (candidateDb.open) candidateDb.close();
      }
    } finally {
      if (fs.existsSync(candidatePath)) fs.rmSync(candidatePath);
    }
  }

  throw new Error(
    `mutateStateDb: too many concurrent commits (${MAX_CAS_ATTEMPTS} attempts) -- try again`,
  );
}
