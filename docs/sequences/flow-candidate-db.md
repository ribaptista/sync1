# Flow: the candidate state.db

**Derived from:** `src/sync/commit.ts`, `src/fs/temp-path.ts`, `src/db/connection.ts`

**Used by:** [`sync.md`](sync.md)

`sync` and `gc` never mutate the live local `state.db` directly. Each builds a **candidate** — a
private temp-file copy — applies every change to that, and only replaces the real file once every
remote commit has genuinely succeeded. A crash at any point before the final rename leaves the live
`state.db` completely untouched, so retrying is always safe: nothing needs to be rolled back, because
nothing durable was changed.

This file describes `sync`'s own candidate lifecycle, which is the more elaborate of the two (`gc`'s and
`mutateStateDb`'s are the simpler version already shown inline in
[`flow-cas-commit.md`](flow-cas-commit.md) — decrypt, mutate, upload, CAS, done in one pass, no
separate remote-fresh fetch step).

## Sequence

```mermaid
sequenceDiagram
    participant Sync as performSync
    participant FS
    participant S3
    participant Candidate as candidate.db (temp)

    Sync->>S3: GET /current (withS3Retry)
    S3-->>Sync: remoteVersionStamp, etag
    Sync->>Sync: remoteHasMoved = remoteVersionStamp !== lastSyncedVersion

    alt remote has moved
        Sync->>S3: GET states/<remoteVersionStamp> (withS3Retry)
        S3-->>Sync: encrypted snapshot
        Sync->>Sync: decryptBuffer (CryptoAuthError -> CorruptionError)
        Sync->>FS: remoteFreshPath = tempSiblingPath(state.db, "remote-fresh")<br/>fs.writeFileSync(remoteFreshPath, decrypted)
        note over Sync: remoteFreshIsTemp = true
    else remote unchanged
        note over Sync: remoteFreshPath = the LIVE local state.db itself --<br/>already exactly what /current points at, no fetch needed
    end

    Sync->>FS: candidatePath = tempSiblingPath(state.db, "candidate")<br/>fs.copyFileSync(remoteFreshPath, candidatePath)
    Sync->>Candidate: openStateDb(candidatePath) -- runs migrations if needed

    Sync->>Candidate: enumerateUploadWork(dirtyRows, objectsRepo) -- a second, offline, SQL-only<br/>walk of the same dirty set, purely so the upload bar opens with a real denominator
    Sync->>FS: write upload-in-progress marker (timestamp) -- BEFORE either apply call<br/>survives to be found by verifyRemote on a future run if this one dies
    Sync->>Candidate: applyLocalChangesToCandidate(dirtyRows, ..., estimatedTotals)<br/>-- see flow-apply-local-changes.md.<br/>excludePaths is filled in as a side effect (tapPaths) of iterating this same dirty set
    Sync->>Candidate: applyRemoteChangesToLocal(..., excludePaths) -- see flow-apply-remote-changes.md
    Sync->>Candidate: candidateDb.close() -- checkpoints WAL so the file on disk is complete

    alt willCommit (appliedCount > 0)
        Sync->>FS: fs.readFileSync(candidatePath)
        Sync->>Sync: encryptBuffer(candidateBytes, masterKey, randomBytes(16))
        Sync->>S3: PUT states/<versionStamp> (withS3Retry)
        note over Sync: mirrorStateSnapshot -- see flow-mirror-metadata.md
        Sync->>S3: CAS PUT /current -- see flow-cas-commit.md, Shape 1
        alt CAS succeeds
            note over Sync: mirrorCurrentPointer -- see flow-mirror-metadata.md
            Sync->>FS: renameWithRetry(candidatePath, state.db)
            Sync->>FS: write last_synced_version; rm upload-in-progress marker
            Sync->>Candidate: reconcileCacheAfterCommit(cacheRepo, handled dirty rows, handledPaths)
        else CasConflictError
            Sync-->>Sync: throw RemoteDivergedError -- candidatePath never promoted,<br/>marker deliberately left in place (this run's own uploads may still be unresolved)
        end
    else nothing new to commit
        note over Sync: no PUT, no CAS at all
        Sync->>FS: rm upload-in-progress marker -- appliedCount was never above 0,<br/>so nothing from this run's uploads is unresolved
        opt remote had moved
            Sync->>FS: copyFileWithRetry(remoteFreshPath, state.db)<br/>write last_synced_version = remoteVersionStamp
        end
        Sync->>Candidate: reconcileCacheAfterCommit(cacheRepo, handled dirty rows, handledPaths)<br/>-- still reconciles any no-op-resolved rows to 'unchanged'
        note over Sync: candidatePath is simply discarded, never promoted
    end

    Sync->>FS: finally -- rm candidatePath if it still exists;<br/>rm remoteFreshPath if it was a temp
```

## Notes

- **Concurrency:** none in this flow itself — it is the sequential spine `applyLocalChangesToCandidate`
  and `applyRemoteChangesToLocal` (each internally concurrent) run inside.
- **On failure:**
  - Any throw before the CAS attempt leaves `candidatePath` and (if fetched) `remoteFreshPath` as
    ordinary temp files, removed by this run's own `finally`, or by the next run's
    `sweepStaleTempFiles` if the process was killed outright (see
    [`flow-preamble.md`](flow-preamble.md)).
  - A `CasConflictError` becomes `RemoteDivergedError`: `candidatePath` is discarded unpromoted, and
    the dirty rows it would have committed stay dirty in cache.db for the next run. The
    upload-in-progress marker is deliberately **not** removed here — this run's uploads reached S3 but
    were never recorded in a promoted `state.db`, exactly the condition the marker exists to flag for
    the next run's `verifyRemote` HEAD-before-upload check.
  - The marker is written once, right at the start of this flow (before either apply call), and is
    cleared on both clean-exit paths (a promoted commit, or "nothing to commit") but deliberately
    **not** in a `finally` — an abort or a thrown error is exactly what it exists to survive, so the
    next run can tell "did an earlier attempt get far enough to maybe upload something."
  - The rename onto `state.db` is the one non-idempotent, no-going-back step in this whole flow — it
    happens strictly after the CAS has already succeeded, so a crash _between_ the CAS landing and the
    rename leaves S3 committed to the new version while the local `state.db` and `last_synced_version`
    are still one version behind. The next `sync` detects this via `remoteHasMoved` and simply adopts
    the new remote state rather than trying to redo anything.
- **Two live temp files, two different origins:** `candidatePath` always exists once this flow starts;
  `remoteFreshPath` is a real second temp file only when the remote moved, and is otherwise just an
  alias for the existing local `state.db` (never removed in that case — `remoteFreshIsTemp` gates the
  cleanup specifically so the live file is never mistaken for a temp one).
- **Sub-flows:** [`flow-apply-local-changes.md`](flow-apply-local-changes.md),
  [`flow-apply-remote-changes.md`](flow-apply-remote-changes.md),
  [`flow-cas-commit.md`](flow-cas-commit.md), [`flow-mirror-metadata.md`](flow-mirror-metadata.md).
