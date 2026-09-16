import type {
  CacheEntriesRepository,
  CacheEntryRow,
} from "../db/repositories/cache-entries-repository.js";
import type { HandledPathStamps } from "./apply-local-changes.js";

/**
 * After a successfully committed sync: created/modified rows become
 * 'unchanged' at the baseline the vault actually holds for that path (see
 * `HandledPathStamps` -- this is deliberately per-path, not one commit-level
 * stamp for the whole batch); deleted rows are removed entirely (no
 * tombstones), mirroring state.db's own no-tombstone philosophy. Must only
 * be called after the remote commit (state.db upload + CAS on /current)
 * has actually succeeded -- never before.
 */
export function reconcileCacheAfterCommit(
  cacheRepo: CacheEntriesRepository,
  dirtyRows: Iterable<CacheEntryRow>,
  handledStamps: HandledPathStamps,
): void {
  for (const row of dirtyRows) {
    if (row.state === "deleted") {
      cacheRepo.delete(row.path);
      continue;
    }
    const stamp = handledStamps.get(row.path);
    if (stamp == null) {
      // Unreachable: callers only ever pass rows already filtered down to
      // handled paths, and a handled non-deleted row always has a stamp.
      throw new Error(`no vault version stamp recorded for handled path "${row.path}"`);
    }
    cacheRepo.upsert({ ...row, state: "unchanged", parent_state_version: stamp });
  }
}
