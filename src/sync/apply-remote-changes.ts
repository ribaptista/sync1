import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";
import { EntriesRepository, type EntryRow } from "../db/repositories/entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import { hashBufferHex } from "../crypto/hash.js";
import { decryptBuffer, CryptoAuthError } from "../crypto/chunked-codec.js";
import { getObject } from "../s3/client.js";
import { remoteKey, type RemoteLocation } from "../vault/paths.js";
import { writeStubAtomic, stubPathFor } from "../fs/stub.js";

export interface ApplyRemoteChangesResult {
  created: number;
  modified: number;
  deleted: number;
}

/**
 * Diffs cache.db's *current* content directly against the candidate
 * state.db (which, by the time this runs, already reflects remote's latest
 * plus this machine's own successfully-applied local edits) to find every
 * path that isn't already correctly materialized locally, and applies each
 * to the filesystem + cache.db.
 *
 * This deliberately does NOT compare two state.db snapshots by version
 * stamp -- a version-stamp comparison is the wrong basis. Right after a
 * fresh attach_remote, local state.db is already fully populated (fetched)
 * but cache.db is completely empty (nothing materialized yet), so "has the
 * version stamp changed" says no while everything still needs downloading.
 * Diffing cache.db's actual hashes against the candidate's is what's
 * actually true regardless of *why* they diverged.
 *
 * A brand-new path (never in cache.db before) defaults to a **stub**, not a
 * full download -- this is what makes attach_remote + sync a real restore
 * without downloading the whole backup. An already-known path preserves
 * whatever representation it currently has: already-stubbed stays a stub
 * (just its referenced hash is updated, no download at all); already
 * materialized stays materialized (downloads the new content).
 *
 * `excludePaths` (this machine's own dirty rows) are skipped entirely --
 * handled by apply-local-changes.ts instead, or deliberately left
 * conflicted; this function never overwrites a file the user has a pending
 * edit to. Uses a second, read-only connection to cache.db so it can
 * iterate it while the caller's own connection is used to write.
 */
export async function applyRemoteChangesToLocal(
  candidateDb: Database.Database,
  cacheDbPath: string,
  root: string,
  masterKey: Buffer,
  cacheRepo: CacheEntriesRepository,
  excludePaths: ReadonlySet<string>,
  newBaselineVersion: string,
  s3: { client: S3Client; bucket: string; location: RemoteLocation },
  logger: Logger,
): Promise<ApplyRemoteChangesResult> {
  const candidateEntries = new EntriesRepository(candidateDb);
  const candidateObjects = new ObjectsRepository(candidateDb);

  const cacheReadDb = new Database(cacheDbPath, { readonly: true, fileMustExist: true });
  try {
    const cacheReadRepo = new CacheEntriesRepository(cacheReadDb);
    const cacheIter = cacheReadRepo.iterateAllSortedByPath();
    const candidateIter = candidateEntries.iterateAllSortedByPath();

    let cacheNext = cacheIter.next();
    let candidateNext = candidateIter.next();

    const result: ApplyRemoteChangesResult = { created: 0, modified: 0, deleted: 0 };

    while (!cacheNext.done || !candidateNext.done) {
      const cacheEntry = cacheNext.done ? null : cacheNext.value;
      const candidateEntry = candidateNext.done ? null : candidateNext.value;

      if (
        candidateEntry !== null &&
        (cacheEntry === null || candidateEntry.path < cacheEntry.path)
      ) {
        // Not tracked in cache.db at all -- either genuinely new remotely,
        // or (the attach_remote case) never materialized locally yet.
        // Either way: default to a stub, never a download.
        if (!excludePaths.has(candidateEntry.path)) {
          await applyRemoteContentChange(
            candidateEntry,
            root,
            masterKey,
            candidateObjects,
            cacheRepo,
            newBaselineVersion,
            true,
            s3,
            logger,
          );
          result.created++;
        }
        candidateNext = candidateIter.next();
      } else if (
        cacheEntry !== null &&
        (candidateEntry === null || cacheEntry.path < candidateEntry.path)
      ) {
        // Tracked locally but gone from state.db -- deleted remotely.
        if (!excludePaths.has(cacheEntry.path)) {
          applyRemoteDelete(cacheEntry.path, cacheEntry.type, root, cacheRepo, logger);
          result.deleted++;
        }
        cacheNext = cacheIter.next();
      } else if (cacheEntry !== null && candidateEntry !== null) {
        if (!excludePaths.has(candidateEntry.path) && cacheEntry.hash !== candidateEntry.hash) {
          // Already known locally: preserve whatever representation is
          // currently on disk rather than the default-to-stub policy above.
          const preserveAsStub = currentlyStubBacked(root, candidateEntry.path);
          await applyRemoteContentChange(
            candidateEntry,
            root,
            masterKey,
            candidateObjects,
            cacheRepo,
            newBaselineVersion,
            preserveAsStub,
            s3,
            logger,
          );
          result.modified++;
        }
        cacheNext = cacheIter.next();
        candidateNext = candidateIter.next();
      }
    }

    return result;
  } finally {
    cacheReadDb.close();
  }
}

function currentlyStubBacked(root: string, entryPath: string): boolean {
  const absolutePath = path.join(root, entryPath);
  return !fs.existsSync(absolutePath) && fs.existsSync(stubPathFor(absolutePath));
}

async function applyRemoteContentChange(
  entry: EntryRow,
  root: string,
  masterKey: Buffer,
  candidateObjects: ObjectsRepository,
  cacheRepo: CacheEntriesRepository,
  newBaselineVersion: string,
  writeAsStub: boolean,
  s3: { client: S3Client; bucket: string; location: RemoteLocation },
  logger: Logger,
): Promise<void> {
  const absolutePath = path.join(root, entry.path);

  if (entry.type === "dir") {
    fs.mkdirSync(absolutePath, { recursive: true });
    cacheRepo.upsert({
      path: entry.path,
      type: "dir",
      mtime: Math.round(fs.statSync(absolutePath).mtimeMs),
      hash: null,
      state: "unchanged",
      parent_state_version: newBaselineVersion,
    });
    logger.debug({ path: entry.path }, "materialized remote directory");
    return;
  }

  if (!entry.hash) throw new Error(`remote entry for "${entry.path}" is a file with no hash`);
  const objectRow = candidateObjects.get(entry.hash);
  if (!objectRow) {
    throw new Error(
      `remote entry for "${entry.path}" references unknown object hash ${entry.hash}`,
    );
  }

  if (writeAsStub) {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const stubAbsolutePath = stubPathFor(absolutePath);
    writeStubAtomic(stubAbsolutePath, entry.hash);
    cacheRepo.upsert({
      path: entry.path,
      type: "file",
      mtime: Math.round(fs.statSync(stubAbsolutePath).mtimeMs),
      hash: entry.hash,
      state: "unchanged",
      parent_state_version: newBaselineVersion,
    });
    logger.debug(
      { path: entry.path, hash: entry.hash },
      "wrote stub for remote content (no download)",
    );
    return;
  }

  const encrypted = await getObject(s3.client, s3.bucket, remoteKey(s3.location, objectRow.s3_key));
  if (!encrypted) {
    throw new Error(`object ${entry.hash} for "${entry.path}" is missing in S3 (corrupt vault?)`);
  }

  let plaintext: Buffer;
  try {
    plaintext = decryptBuffer(encrypted.body, masterKey);
  } catch (err) {
    if (err instanceof CryptoAuthError) {
      throw new Error(`object ${entry.hash} for "${entry.path}" failed decryption/authentication`);
    }
    throw err;
  }
  if (hashBufferHex(plaintext) !== entry.hash) {
    throw new Error(`object ${entry.hash} for "${entry.path}" does not match its recorded hash`);
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const tmpPath = `${absolutePath}.sync1-tmp-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmpPath, plaintext);
  fs.renameSync(tmpPath, absolutePath);

  cacheRepo.upsert({
    path: entry.path,
    type: "file",
    mtime: Math.round(fs.statSync(absolutePath).mtimeMs),
    hash: entry.hash,
    state: "unchanged",
    parent_state_version: newBaselineVersion,
  });
  logger.debug({ path: entry.path, hash: entry.hash }, "materialized remote file create/modify");
}

function applyRemoteDelete(
  entryPath: string,
  entryType: "file" | "dir",
  root: string,
  cacheRepo: CacheEntriesRepository,
  logger: Logger,
): void {
  const absolutePath = path.join(root, entryPath);
  try {
    if (entryType === "dir") {
      fs.rmdirSync(absolutePath); // best-effort; leaves it if not empty (e.g. conflicted children remain)
    } else {
      fs.rmSync(absolutePath);
    }
  } catch {
    // already gone, or non-empty directory -- not fatal either way
  }
  try {
    fs.rmSync(stubPathFor(absolutePath));
  } catch {
    // no stub -- fine, this was a materialized path
  }
  cacheRepo.delete(entryPath);
  logger.debug({ path: entryPath }, "applied remote deletion");
}
