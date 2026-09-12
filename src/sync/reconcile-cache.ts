import type {
  CacheEntriesRepository,
  CacheEntryRow,
} from "../db/repositories/cache-entries-repository.js";

/**
 * After a successfully committed sync: created/modified rows become
 * 'unchanged' at the new baseline; deleted rows are removed entirely (no
 * tombstones), mirroring state.db's own no-tombstone philosophy. Must only
 * be called after the remote commit (state.db upload + CAS on /current)
 * has actually succeeded -- never before.
 */
export function reconcileCacheAfterCommit(
  cacheRepo: CacheEntriesRepository,
  dirtyRows: Iterable<CacheEntryRow>,
  newVersionStamp: string,
): void {
  for (const row of dirtyRows) {
    if (row.state === "deleted") {
      cacheRepo.delete(row.path);
      continue;
    }
    cacheRepo.upsert({ ...row, state: "unchanged", parent_state_version: newVersionStamp });
  }
}
