import fs from "node:fs";
import { randomBytes } from "node:crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";
import { openStateDb } from "../db/connection.js";
import { EntriesRepository } from "../db/repositories/entries-repository.js";
import { ObjectsRepository, type ObjectRow } from "../db/repositories/objects-repository.js";
import { VersionsRepository } from "../db/repositories/versions-repository.js";
import { generateVersionStamp } from "../vault/version-stamp.js";
import { encryptBuffer, decryptBuffer, CryptoAuthError } from "../crypto/chunked-codec.js";
import {
  getObject,
  putObject,
  putObjectCas,
  deleteObject,
  CasConflictError,
} from "../s3/client.js";
import {
  remoteKey,
  stateSnapshotKey,
  CURRENT_POINTER_KEY,
  type RemoteLocation,
} from "../vault/paths.js";
import { localStateDbPath, lastSyncedVersionPath } from "../vault/local-dir.js";

export interface GcResult {
  orphanCount: number;
  reclaimedBytes: number;
  applied: boolean;
}

const MAX_CAS_ATTEMPTS = 5;

function tempSiblingPath(basePath: string, tag: string): string {
  return `${basePath}.${tag}-${randomBytes(4).toString("hex")}`;
}

/**
 * Removes objects no longer referenced by any *current* entry -- scoped to
 * the live state only (see docs/architecture/garbage-collection-scope.md
 * for why old /states/<version> snapshots are deliberately allowed to lose
 * content-recoverability for reclaimed objects; this is what actually
 * reclaims storage, since keeping every version forever would otherwise
 * pin every hash ever referenced).
 *
 * Always re-fetches /current fresh (never trusts local state.db, which may
 * be stale) and, on a CAS conflict against /current, refetches and
 * recomputes from scratch rather than failing outright -- unlike `sync`,
 * removing orphans is a pure recomputation with no human conflict to
 * resolve, so retrying automatically is safe.
 *
 * `onBeforeCas` is a test-only seam: called immediately before each CAS
 * attempt, giving a test a deterministic point to inject a competing
 * commit and force a real retry, rather than relying on real-world timing
 * between two separate processes.
 */
export async function performGc(
  root: string,
  masterKey: Buffer,
  s3: { client: S3Client; bucket: string; location: RemoteLocation },
  apply: boolean,
  logger: Logger,
  onBeforeCas?: () => Promise<void>,
): Promise<GcResult> {
  const currentKey = remoteKey(s3.location, CURRENT_POINTER_KEY);

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const current = await getObject(s3.client, s3.bucket, currentKey);
    if (!current) throw new Error("vault has no /current pointer (corrupt vault?)");
    const versionStamp = current.body.toString("utf8");

    const snapshot = await getObject(
      s3.client,
      s3.bucket,
      remoteKey(s3.location, stateSnapshotKey(versionStamp)),
    );
    if (!snapshot) throw new Error(`state.db snapshot for version "${versionStamp}" is missing`);

    let decrypted: Buffer;
    try {
      decrypted = decryptBuffer(snapshot.body, masterKey);
    } catch (err) {
      if (err instanceof CryptoAuthError) {
        throw new Error("state.db snapshot failed decryption/authentication");
      }
      throw err;
    }

    const candidatePath = tempSiblingPath(localStateDbPath(root), "gc-candidate");
    fs.writeFileSync(candidatePath, decrypted);

    try {
      const candidateDb = openStateDb(candidatePath, logger);
      let orphans: ObjectRow[];
      try {
        const entriesRepo = new EntriesRepository(candidateDb);
        const objectsRepo = new ObjectsRepository(candidateDb);

        const referenced = new Set<string>();
        for (const { hash } of entriesRepo.iterateDistinctReferencedHashes()) referenced.add(hash);
        orphans = [...objectsRepo.iterateAll()].filter((o) => !referenced.has(o.hash));

        if (!apply || orphans.length === 0) {
          return {
            orphanCount: orphans.length,
            reclaimedBytes: orphans.reduce((sum, o) => sum + o.size, 0),
            applied: false,
          };
        }

        for (const o of orphans) objectsRepo.delete(o.hash);
        const newVersionStamp = generateVersionStamp();
        new VersionsRepository(candidateDb).insert(newVersionStamp, new Date().toISOString());
        logger.debug(
          { orphanCount: orphans.length, versionStamp: newVersionStamp },
          "gc: removing orphan object references",
        );

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
            {
              ifMatch: current.etag,
            },
          );
        } catch (err) {
          if (err instanceof CasConflictError) {
            logger.debug({ attempt }, "gc: CAS conflict, refetching and recomputing");
            continue; // another commit landed first -- recompute from the new /current
          }
          throw err;
        }

        // Only now, after the CAS succeeded, is it safe to delete the
        // actual object bytes -- any future commit referencing one of
        // these hashes again would have to build on this version (or
        // later), which no longer lists them, so it would simply re-upload.
        for (const o of orphans) {
          await deleteObject(s3.client, s3.bucket, remoteKey(s3.location, o.s3_key));
        }

        fs.copyFileSync(candidatePath, localStateDbPath(root));
        fs.writeFileSync(lastSyncedVersionPath(root), newVersionStamp, "utf8");

        return {
          orphanCount: orphans.length,
          reclaimedBytes: orphans.reduce((sum, o) => sum + o.size, 0),
          applied: true,
        };
      } finally {
        if (candidateDb.open) candidateDb.close();
      }
    } finally {
      if (fs.existsSync(candidatePath)) fs.rmSync(candidatePath);
    }
  }

  throw new Error(`gc: too many concurrent commits (${MAX_CAS_ATTEMPTS} attempts) -- try again`);
}
