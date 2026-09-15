import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";
import { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import { writeStubAtomic, stubPathFor } from "./stub.js";
import { BoundedTaskTracker } from "../concurrency/pools.js";
import type { HashRunner } from "../concurrency/hash-runner.js";
import type { OnProgress } from "../progress-types.js";

export interface StubifySkip {
  path: string;
  reason: string;
}

export interface StubifyStats {
  stubified: number;
  alreadyStub: number;
  skipped: StubifySkip[];
}

/**
 * Replaces every real file matching `glob` with a stub, provided it's fully
 * committed. The precondition mirrors materialize's own freshness check:
 * skip the (potentially expensive) rehash when the file's mtime still
 * matches cache.db's recorded baseline; only rehash when it doesn't, and
 * require the result to still match before proceeding -- otherwise this
 * would silently discard an un-synced edit by deleting the real file out
 * from under it.
 *
 * A needed rehash is *dispatched* to `hashRunner` (worker threads, via
 * `hashJobs`) rather than awaited inline, same as update_cache/sanity_check
 * -- the glob scan advances immediately, rehashes run concurrently in the
 * background, and `hashJobs.onIdle()` joins them all before this returns.
 * The common case (mtime unchanged) never touches the pool at all.
 *
 * Crash-safety mirrors materialize's, in reverse: the stub is written
 * (atomically, via tmp + rename) *before* the real file is deleted, so an
 * interrupted stubify also lands in the safe "both exist" state.
 */
export async function stubifyGlob(
  root: string,
  glob: string,
  cacheRepo: CacheEntriesRepository,
  logger: Logger,
  hashRunner: HashRunner,
  maxInFlightHashes: number,
  onProgress?: OnProgress,
): Promise<StubifyStats> {
  const stats: StubifyStats = { stubified: 0, alreadyStub: 0, skipped: [] };
  const hashJobs = new BoundedTaskTracker(maxInFlightHashes);

  // filesDone/filesTotal track every glob-matched row (mirroring this
  // scan's pre-existing "scanned" counter); bytesDone/bytesTotal track only
  // a genuine rehash -- the common mtime-unchanged fast path below (which
  // never reads through the file's content at all) contributes 0.
  let scanned = 0;
  let bytesTotal = 0;
  let bytesDone = 0;
  const report = (): void => {
    onProgress?.({ filesDone: scanned, filesTotal: scanned, bytesDone, bytesTotal });
  };

  // A single connection/repo covers both the glob scan and cacheRepo.upsert()
  // below: iterateByGlobSortedByPath() is keyset-paginated (src/db/keyset-
  // pagination.ts), not a live `.iterate()` cursor, so the write can safely
  // interleave with it -- a write only ever conflicts with a *paused*
  // cursor, and pagination never leaves one paused between pages.
  for (const row of cacheRepo.iterateByGlobSortedByPath(glob)) {
    scanned++;
    report();
    if (row.type !== "file") continue;
    const absolutePath = path.join(root, row.path);
    const stubAbsolutePath = stubPathFor(absolutePath);

    if (!fs.existsSync(absolutePath)) {
      stats.alreadyStub++;
      continue;
    }

    if (row.state !== "unchanged") {
      stats.skipped.push({
        path: row.path,
        reason: "not fully committed (has pending local changes)",
      });
      continue;
    }

    const finalize = (confirmedHash: string | null): void => {
      if (!confirmedHash) throw new Error(`cache row for "${row.path}" has no hash`);
      writeStubAtomic(stubAbsolutePath, confirmedHash); // write the stub first...
      fs.rmSync(absolutePath); // ...only then delete the real file
      cacheRepo.upsert({ ...row, mtime: Math.round(fs.statSync(stubAbsolutePath).mtimeMs) });
      stats.stubified++;
      logger.debug({ path: row.path }, "stubified");
    };

    const currentMtime = Math.round(fs.statSync(absolutePath).mtimeMs);
    if (currentMtime === row.mtime) {
      finalize(row.hash);
      continue;
    }

    // non-null: row.state === "unchanged" (checked above) means this is a
    // live, tracked file row, and the DB's CHECK constraint (see
    // 0004_add_size.sql) guarantees size is NOT NULL for any such row.
    const size = row.size!;
    bytesTotal += size;
    report();
    await hashJobs.dispatch(async () => {
      const rehash = await hashRunner.run(absolutePath);
      // The work of reading through the file happened either way, whether
      // or not the rehash actually confirms row.hash below.
      bytesDone += size;
      report();
      logger.debug({ pool: "hash", inFlight: hashJobs.size }, "completed");
      if (rehash !== row.hash) {
        stats.skipped.push({
          path: row.path,
          reason: "file changed since it was last synced -- run sync first",
        });
        return;
      }
      finalize(rehash);
    });
    logger.debug({ pool: "hash", inFlight: hashJobs.size }, "dispatched");
  }

  await hashJobs.onIdle();

  return stats;
}
