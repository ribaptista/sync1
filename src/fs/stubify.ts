import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";
import { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import { hashFile } from "./hash-file.js";
import { writeStubAtomic, stubPathFor } from "./stub.js";

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
 * Crash-safety mirrors materialize's, in reverse: the stub is written
 * (atomically, via tmp + rename) *before* the real file is deleted, so an
 * interrupted stubify also lands in the safe "both exist" state.
 */
export async function stubifyGlob(
  root: string,
  glob: string,
  cacheRepo: CacheEntriesRepository,
  logger: Logger,
): Promise<StubifyStats> {
  const stats: StubifyStats = { stubified: 0, alreadyStub: 0, skipped: [] };

  // A single connection/repo covers both the glob scan and cacheRepo.upsert()
  // below: iterateByGlobSortedByPath() is keyset-paginated (src/db/keyset-
  // pagination.ts), not a live `.iterate()` cursor, so the write can safely
  // interleave with it -- a write only ever conflicts with a *paused*
  // cursor, and pagination never leaves one paused between pages.
  {
    for (const row of cacheRepo.iterateByGlobSortedByPath(glob)) {
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

      let confirmedHash = row.hash;
      const currentMtime = Math.round(fs.statSync(absolutePath).mtimeMs);
      if (currentMtime !== row.mtime) {
        const rehash = await hashFile(absolutePath);
        if (rehash !== row.hash) {
          stats.skipped.push({
            path: row.path,
            reason: "file changed since it was last synced -- run sync first",
          });
          continue;
        }
        confirmedHash = rehash;
      }
      if (!confirmedHash) throw new Error(`cache row for "${row.path}" has no hash`);

      writeStubAtomic(stubAbsolutePath, confirmedHash); // write the stub first...
      fs.rmSync(absolutePath); // ...only then delete the real file

      cacheRepo.upsert({ ...row, mtime: Math.round(fs.statSync(stubAbsolutePath).mtimeMs) });
      stats.stubified++;
      logger.debug({ path: row.path }, "stubified");
    }
  }

  return stats;
}
