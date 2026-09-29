# `sync1 materialize`

**Derived from:** `src/commands/materialize.ts`, `src/fs/materialize.ts`

Downloads and materializes every stub matching a glob pattern back into a real file: download, decrypt,
verify the hash, write to a temp sibling, rename into place, and only _then_ delete the stub — so an
interrupted run always lands in the safe "both exist" state (the real file already correct;
`update_cache` cleans up the stray stub next scan). Needs the password (see
[`flow-unlock-vault.md`](flow-unlock-vault.md)) — it decrypts content. Runs after the ordinary
lock/root-resolution preamble (see [`flow-preamble.md`](flow-preamble.md)), omitted below since it never
varies.

Uses **two pools nested**: the glob scan dispatches a HEAD check per stub to `s3Pool`; each HEAD's own
completion classifies the archive status and, only for an immediately-retrievable object, dispatches the
actual download to `streamPool`. `s3Pool.onIdle()` is drained before `streamPool.onIdle()` — by the time
every HEAD has settled, every download it might have triggered has already been enqueued.

## Sequence

```mermaid
sequenceDiagram
    participant Loop as glob scan
    participant S3Pool as s3 pool
    participant S3
    participant Archive as flow-archive-status
    participant StreamPool as stream pool
    participant FS
    participant Cache as cache.db

    Loop->>Loop: enumerateMaterializeWork -- offline denominator (cache.db + state.db sizes only, no S3 calls)

    loop each glob-matched row
        alt not a file, or no stub present (already real)
            Loop->>Loop: stats.alreadyReal++ (or skip for a non-file)
        else stub AND real both present (dangling stub)
            Loop->>FS: rm the stray stub -- real file already wins
            Loop->>Loop: stats.alreadyReal++
        else genuinely stub-only
            Loop->>Loop: objectsRepo.get(hash) -- missing -> CorruptionError
            Loop->>Loop: waitForRoom(s3Pool); dispatchTracked(job)
            S3Pool->>S3: headObject(key)
            S3Pool->>Archive: classifyArchiveStatus(head) -- see flow-archive-status.md
            alt immediate or restore-ready
                S3Pool->>StreamPool: waitForRoom; dispatchTracked(download job) -- see below
            else needs-restore-request or restore-expired-needs-reissue
                alt --request-retrieval given
                    S3Pool->>S3: restoreObject(key, days:7, tier:Standard)
                    S3Pool->>Loop: stats.retrievalRequested++
                else
                    S3Pool->>Loop: stats.needsRetrieval++
                end
                S3Pool->>Loop: progress.skipBytes(size) -- counted, not transferred
            else restore-ongoing
                S3Pool->>Loop: stats.pending++; progress.skipBytes(size)
            end
        end
    end

    Loop->>S3Pool: await s3Pool.onIdle(); throwIfPoolErrored()
    Loop->>StreamPool: await streamPool.onIdle(); throwIfPoolErrored()
```

## Sequence — the dispatched download job

```mermaid
sequenceDiagram
    participant Job as download job
    participant S3
    participant FS
    participant Cache as cache.db

    loop withS3Retry(runUnit) -- GET+decrypt is the retriable unit, same shape as apply-remote-changes
        Job->>S3: getObjectStream(key)
        opt missing in S3
            Job--xJob: throw CorruptionError
        end
        Job->>FS: mkdirSync(dirname, recursive); decryptStreamToFile(body, masterKey, tmpPath)
        alt decryption/auth fails, or computed hash != recorded hash
            Job->>FS: rm tmpPath
            Job--xJob: throw CorruptionError
        else
            Job->>FS: durableRename(tmpPath, absolutePath) -- fsync'd, no retry -- see flow-atomic-publish.md
        end
    end
    Job->>FS: rm the stub -- ONLY after the real file is already in place
    Job->>Cache: cacheRepo.upsert({...row, mtime: real file's new mtime})
    Job->>Job: stats.materialized++
```

## Output

```json
{
  "ok": true,
  "materialized": 3,
  "already_real": 1,
  "needs_retrieval": 0,
  "retrieval_requested": 0,
  "pending": 0
}
```

Always `ok: true` when the command completes at all — a thrown error (missing object, hash mismatch,
pool error) fails the command outright rather than reporting a partial `ok: false`.

## Notes

- **Concurrency:** `s3Pool` (HEAD checks) and `streamPool` (downloads) are two independently-bounded
  pools; see [`flow-pool-dispatch.md`](flow-pool-dispatch.md). The glob scan itself is sequential SQL
  (`cacheRepo.iterateByGlobSortedByPath`, keyset-paginated), safe to interleave with this same
  connection's own `cacheRepo.upsert()` calls.
- **The progress denominator counts every stub this run is _responsible for_, including archived
  ones** — an archived object resolves its byte total by having its retrieval requested (or just
  counted), not by transferring anything, so `progress.skipBytes` closes that gap rather than leaving
  the bar short of 100%.
- **`--request-retrieval` is the only thing that spends money/time on a cold object.** Without it, an
  archived stub is only counted (`needsRetrieval`), never touched — matching `status`/`converge`'s own
  restore defaults (`RESTORE_DAYS = 7`, tier `Standard`).
- **On failure:** any thrown error (a missing object, a corrupt/mismatched hash, a stub with no
  recorded hash) propagates out of the dispatched job, is captured by `dispatchTracked`, and fails the
  whole command via `throwIfPoolErrored` after the relevant pool's `onIdle()` — there is no per-row
  partial-failure reporting the way `stubify`'s `skipped` list works. A download that fails after
  decrypting to the temp file leaves only that temp file behind (cleaned up inline); the stub itself is
  never removed until the real file has already been renamed into place.
- **Sub-flows:** [`flow-pool-dispatch.md`](flow-pool-dispatch.md), [`flow-archive-status.md`](flow-archive-status.md),
  [`flow-atomic-publish.md`](flow-atomic-publish.md) (though this call site skips the `renameWithRetry`
  variant), [`flow-s3-retry.md`](flow-s3-retry.md).
