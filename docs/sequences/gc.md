# `sync1 gc`

**Derived from:** `src/commands/gc.ts`, `src/sync/gc.ts`

Removes S3 objects no longer referenced by any _current_ entry — scoped to the live state only (old
`/states/<version>` snapshots are deliberately allowed to lose content-recoverability for a reclaimed
object; see `docs/architecture/garbage-collection-scope.md`). Defaults to counting only; `--apply`
actually deletes. The CAS loop itself, its 5-attempt recompute shape, and the candidate DB lifecycle are
already fully drawn in [`flow-cas-commit.md`](flow-cas-commit.md) (Shapes 2 & 3) — this file covers what
sits either side of that: the orphan staging that decides _what_ to delete, and the two-phase
commit-then-delete ordering that decides _when_ it's safe to actually remove bytes. Needs the password
(see [`flow-unlock-vault.md`](flow-unlock-vault.md)) — the candidate state.db it recomputes from is an
encrypted snapshot. Runs after the ordinary lock/root-resolution preamble (see
[`flow-preamble.md`](flow-preamble.md)), omitted below since it never varies.

## Sequence

```mermaid
sequenceDiagram
    participant CLI as gc command
    participant Cas as flow-cas-commit (Shape 2)
    participant Candidate as candidate.db
    participant S3Pool as s3 pool
    participant S3

    CLI->>Cas: enter the 5-attempt CAS loop -- see flow-cas-commit.md
    Cas->>Candidate: openStateDb(decrypted remote snapshot)

    alt --apply not given (count only)
        Candidate->>Candidate: objectsRepo.countOrphaned() -- read-only, no staging
        Candidate-->>CLI: { orphanCount, reclaimedBytes, applied: false } -- loop exits immediately
    else --apply given
        Candidate->>Candidate: objectsRepo.stageOrphansForDeletion()<br/>-- into a connection-scoped temp table (gc_pending_deletes)
        Candidate->>Candidate: objectsRepo.countStagedOrphans()
        alt orphanCount === 0
            Candidate-->>CLI: { orphanCount: 0, reclaimedBytes: 0, applied: false }<br/>-- loop never reaches a CAS attempt at all
        else
            Candidate->>Candidate: objectsRepo.deleteStagedOrphans() -- removed from THIS candidate's<br/>objects table now, ahead of the CAS
            Candidate->>Candidate: new version stamp; VersionsRepository.insert; wal_checkpoint(TRUNCATE)
            Candidate->>S3: PUT states/<newVersionStamp> (plain, unconditional)
            Cas->>S3: CAS PUT /current, IfMatch: current.etag -- see flow-cas-commit.md for the retry-on-conflict loop
            alt CAS succeeds
                note over Cas: mirrorStateSnapshot + mirrorCurrentPointer --<br/>see flow-mirror-metadata.md. Third commit path to share this hook;<br/>gc originally missed it entirely.
                note over CLI: ONLY NOW is it safe to delete the actual object bytes --<br/>any future commit referencing one of these hashes again would have<br/>to build on this version (or later), which no longer lists them
                loop each staged orphan (iterateStagedOrphans, paginated)
                    CLI->>S3Pool: waitForRoom; dispatchTracked(delete)
                    S3Pool->>S3: deleteObject(key)
                    S3Pool->>CLI: onProgress(deleted++) -- absolute count, pool resolves out of order
                end
                CLI->>S3Pool: await s3Pool.onIdle(); throwIfPoolErrored()
                CLI->>Candidate: copyFileWithRetry(candidatePath, state.db); write last_synced_version
                Candidate-->>CLI: { orphanCount, reclaimedBytes, applied: true }
            end
        end
    end
```

## Output

```json
{ "ok": true, "applied": true, "orphan_count": 12, "reclaimed_bytes": 483920 }
```

Always `ok: true` when the command completes — there is no per-item failure mode reported in the
result; a pool error during the delete sweep throws and fails the command outright instead.

## Notes

- **Concurrency:** the CAS/candidate-recompute loop itself is sequential (see
  [`flow-cas-commit.md`](flow-cas-commit.md)); only the post-CAS S3 delete sweep is concurrent, dispatched
  to `s3Pool` (see [`flow-pool-dispatch.md`](flow-pool-dispatch.md)), and it only starts after the commit
  has already succeeded.
- **"Commit metadata, then delete bytes" is the one ordering fact that makes this whole command
  safe.** The new version's `objects` table stops listing the orphaned hashes _before_ the CAS even
  attempts to land — so the moment the CAS succeeds, no future commit can reference them again, whether
  or not this run ever gets to actually delete the S3 bytes. A crash after the CAS but before (or during)
  the delete sweep just leaves reclaimable orphans for the _next_ `gc --apply` to find and finish; nothing
  is ever deleted before it is provably safe to.
- **The "0 orphans" case never reaches a CAS attempt at all**, even under `--apply` — `applied` is
  `false` because there was genuinely nothing to commit, not because anything failed.
- **On failure:** a delete-sweep failure (captured via `dispatchTracked`/`throwIfPoolErrored`, same
  pattern as every other pool in this codebase) surfaces as a clean, reported error rather than an
  unhandled rejection — but the CAS commit has already succeeded by that point, so this process's own
  local `state.db`/`last_synced_version` promotion is correctly skipped, meaning at least this machine
  doesn't believe the sweep fully completed when it didn't. The next `gc` run recomputes orphans fresh
  against the new `/current` and can pick up any bytes this run failed to delete.
- **Sub-flows:** [`flow-cas-commit.md`](flow-cas-commit.md) (Shapes 2 & 3 — the CAS loop and candidate
  lifecycle), [`flow-mirror-metadata.md`](flow-mirror-metadata.md) (the mirror write after this commit
  path specifically — the one `gc` originally missed), [`flow-pool-dispatch.md`](flow-pool-dispatch.md)
  (the delete sweep).
