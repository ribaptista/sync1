# Flow: applying remote changes to the local filesystem

**Derived from:** `src/sync/apply-remote-changes.ts`

**Used by:** [`sync.md`](sync.md) (via [`flow-candidate-db.md`](flow-candidate-db.md))

`applyRemoteChangesToLocal` is sync's download phase. It diffs `cache.db`'s current content directly
against the candidate `state.db` (which by this point already reflects remote's latest plus this
machine's own successfully-applied local edits — see
[`flow-apply-local-changes.md`](flow-apply-local-changes.md)) via a **sorted merge-join** over both
tables' paths, and applies each divergence to the filesystem plus `cache.db`. It deliberately does not
compare version stamps: right after `attach_remote`, `state.db` is already fully populated but
`cache.db` is empty, so a version-stamp comparison would say "nothing changed" while everything still
needs materializing.

Every branch below is synchronous except the dispatched download job, so a run dominated by stub
writes, directory creation, and deletes (the common case right after `attach_remote`) never yields to
the event loop on its own -- cli-progress's progress-bar repaint runs off a macrotask timer, which can
only fire once the loop actually yields. `YIELD_EVERY_ROWS` (see the loop below) exists purely for
that: every 32 rows, `await`s `node:timers/promises`' `setImmediate` after a row is fully applied, so
the bar this phase feeds stays live instead of freezing for the whole pass. See
[`concurrency-and-progress.md`](../architecture/concurrency-and-progress.md).

## Sequence — the merge-join

```mermaid
sequenceDiagram
    participant Loop as merge-join loop
    participant Cache as cache.db
    participant Candidate as candidate.db (entries/objects)
    participant Apply as applyRemoteContentChange
    participant FS

    loop while either cursor has rows left
        alt candidate-only path (new remotely, or never materialized -- attach_remote)
            opt not in excludePaths
                Loop->>Apply: applyRemoteContentChange(entry, writeAsStub=true)
                Loop->>Loop: result.created++
                opt path matches a global ignore policy
                    Loop->>Loop: ignoredButSynced.push({path, matchedGlob}) -- warning, not a failure
                end
            end
        else cache-only path (tracked locally, gone from state.db)
            opt not in excludePaths
                Loop->>FS: rmSync file or rmdirSync dir (best-effort); rmSync stub if present
                Loop->>Cache: cacheRepo.delete(path)
                Loop->>Loop: result.deleted++
            end
        else path in both, hashes differ
            opt not in excludePaths
                Loop->>FS: currentlyStubBacked? (no real file, but a .stub exists)
                Loop->>Apply: applyRemoteContentChange(entry, writeAsStub=<preserve current representation>)
                Loop->>Loop: result.modified++
            end
        else path in both, hashes equal
            Loop->>Loop: nothing to do
        end
        opt every 32 rows (YIELD_EVERY_ROWS)
            Loop->>Loop: await setImmediate() -- lets the progress bar's own repaint timer fire
        end
    end

    Loop->>Loop: await streamPool.onIdle(); throwIfPoolErrored()
```

## Sequence — `applyRemoteContentChange`: stub vs. download

```mermaid
sequenceDiagram
    participant Apply as applyRemoteContentChange
    participant Candidate as candidate.db (objects)
    participant FS
    participant S3
    participant Cache as cache.db

    alt entry.type = "dir"
        Apply->>FS: mkdirSync(recursive)
        Apply->>Cache: cacheRepo.upsert({type:"dir", state:"unchanged", parent_state_version:entry.state_version})
    else entry.type = "file"
        Apply->>Candidate: objectsRepo.get(entry.hash)
        alt no such object row
            Apply--xApply: throw CorruptionError -- entry references an unknown hash
        end
        alt writeAsStub
            Apply->>FS: writeStubAtomic(stubPath, entry.hash) -- no download at all
            Apply->>Cache: cacheRepo.upsert({hash, size: objectRow.size, state:"unchanged", ...})
        else real download needed
            Apply->>Apply: waitForRoom(streamPool); dispatchTracked(job) -- see below
        end
    end
```

## Sequence — the dispatched download job

```mermaid
sequenceDiagram
    participant Job as dispatched job
    participant S3
    participant FS
    participant Cache as cache.db

    loop withS3Retry(runUnit) -- one attempt, GET+decrypt is the retriable unit
        Job->>S3: getObjectStream(objectRow.s3_key)
        opt object missing in S3
            Job--xJob: throw CorruptionError (not retried further -- see below)
        end
        Job->>FS: mkdirSync(dirname, recursive); decryptStreamToFile(body, masterKey, tmpPath)
        alt decryption/auth fails
            Job->>FS: rm tmpPath
            Job--xJob: throw CorruptionError
        else computed hash != entry.hash
            Job->>FS: rm tmpPath
            Job--xJob: throw CorruptionError
        else
            Job->>FS: durableRename(tmpPath, absolutePath) -- fsync'd, see flow-atomic-publish.md
        end
    end

    alt attempt failed (any error, including CorruptionError)
        Job->>Job: fileTracker.abort()
        note over Job: rethrown -- NOT swallowed, unlike a failed upload.<br/>Ends the whole run via throwIfPoolErrored after streamPool.onIdle().
    else succeeded
        Job->>Cache: cacheRepo.upsert({hash, size: objectRow.size, state:"unchanged", parent_state_version: entry.state_version})
        Job->>Job: fileTracker.finish()
    end
```

## Notes

- **Concurrency:** the merge-join itself is fully sequential — directory creation and stub writes are
  cheap, synchronous, and never touch the pool. Only a genuine download (the "already materialized,
  content changed" case) is dispatched to `streamPool`, bounded by `streamQueueLimit` (see
  [`flow-pool-dispatch.md`](flow-pool-dispatch.md)). No in-memory ledger is needed across dispatches the
  way `apply-local-changes.ts` needs one — this function does no cross-row dedup or collision detection
  of its own, so a dispatched download is never looked up again by a later row.
- **A brand-new path always defaults to a stub, never a download** — this is what makes
  `attach_remote` + `sync` a real restore without pulling the whole backup. An already-known path
  instead **preserves its current representation**: already-stubbed stays a stub (only the referenced
  hash is updated); already materialized stays materialized (the new content is downloaded).
- **`excludePaths`** (this machine's own dirty rows, handled by
  [`flow-apply-local-changes.md`](flow-apply-local-changes.md) instead, or deliberately left conflicted)
  are skipped in every branch of the merge-join — this function never overwrites a file the user has a
  pending edit to.
- **A path matching a global ignore policy can still be materialized here** — ignore policies gate new
  local _creations_ only, never retroactively un-share content already committed to the vault before the
  policy existed. Reported via `ignoredButSynced`, a warning rather than a failure.
- **On failure, this is deliberately less forgiving than the upload side.** A failed download is
  **not** swallowed and left dirty for a retry next time (there is no cache-row-level "dirty" state a
  download failure could fall back into, the way an upload leaves `cache.db` untouched) — it rethrows,
  is captured by `dispatchTracked`, and ends the whole run via `throwIfPoolErrored` once
  `streamPool.onIdle()` settles. `CorruptionError` (object missing in S3, decryption/auth failure, or a
  hash mismatch after decrypt) is not retried by `withS3Retry` at all — a truncated or tampered download
  must never be mistaken for a flaky link.
- **Every cache row this writes takes its `parent_state_version` from the candidate entry's own
  `state_version`** — the version at which _this path's_ row was last written remotely, never the
  version of whatever commit happens to be in flight. `conflict-rules.ts` relies on comparing exactly
  this against a cache row's `parent_state_version` (see
  [`flow-apply-local-changes.md`](flow-apply-local-changes.md) and
  `docs/architecture/conflict-resolution.md`).
- **Sub-flows:** [`flow-pool-dispatch.md`](flow-pool-dispatch.md) (the stream pool dispatch),
  [`flow-s3-retry.md`](flow-s3-retry.md) (the unbounded retry around the GET+decrypt unit). Decryption
  itself goes through `decryptStreamToFile`, the read-side counterpart to
  [`flow-encrypt-stream.md`](flow-encrypt-stream.md)'s chunked AEAD, but streams to a temp file rather
  than through the tee/multi-sink machinery `apply-local-changes.ts` uses, so it is not itself a
  documented flow file here.
