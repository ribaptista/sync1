# Flow: applying local changes to the candidate

**Derived from:** `src/sync/apply-local-changes.ts`, `src/sync/conflict-rules.ts`,
`src/s3/policy-evaluation.ts`

**Used by:** [`sync.md`](sync.md) (via [`flow-candidate-db.md`](flow-candidate-db.md))

`applyLocalChangesToCandidate` folds every dirty `cache.db` row into the candidate `state.db`
(see [`flow-candidate-db.md`](flow-candidate-db.md) for that database's own lifecycle). It runs as
**two passes** over `dirtyRows` — deletes first, then creates/modifies — because
`CacheEntriesRepository.iterateDirty()` already yields every `deleted` row before anything else, and
letting deletes finish first means Pass 2's collision/existence checks can trust a plain read of the
live candidate again, with no in-memory ledger of what Pass 1 already did.

## Sequence — Pass 1: deletes

Fully sequential: no I/O, no pool. Every row is resolved synchronously before Pass 2 even starts
reading.

```mermaid
sequenceDiagram
    participant Loop as Pass 1 loop
    participant Rules as decideLocalChange
    participant Candidate as candidate.db (entries)

    loop each row with state="deleted"
        Loop->>Candidate: entries.get(row.path)
        Loop->>Rules: decideLocalChange(row, existingEntry)
        alt conflict
            Rules-->>Loop: {kind:"conflict", reason}
            Loop->>Loop: conflicts.push({path, reason}); row stays dirty
        else apply (existingEntry was truthy)
            Rules-->>Loop: {kind:"apply"}
            Loop->>Candidate: entriesRepo.deleteWithHistory(existingEntry, versionStamp)
            Loop->>Loop: handledPaths.set(path, null); appliedCount++
        else noop (already gone remotely)
            Rules-->>Loop: {kind:"noop"}
            Loop->>Loop: handledPaths.set(path, null) -- nothing written to entries
        end
    end
```

## Sequence — Pass 2: the decision ladder

Decide-then-dispatch: only the actual object upload is handed to `streamPool` (see
[`flow-pool-dispatch.md`](flow-pool-dispatch.md)); everything up to that point runs inline so the loop
can advance to the next row immediately.

```mermaid
sequenceDiagram
    participant Loop as Pass 2 loop
    participant Rules as decideLocalChange
    participant Candidate as candidate.db
    participant Mirror as mirror (fs)
    participant S3

    loop each remaining row
        opt streamPoolErrors already holds an error
            Loop--xLoop: break -- a dispatched job already failed fatally<br/>(MirrorRequiredError, or an unexpected candidate-DB write failure);<br/>no point feeding this doomed run more work
        end
        alt row.state = "created"
            Loop->>Candidate: findByNormalizedPath(collision key)
            Loop->>Loop: check inFlightByNormalizedPath too
            opt collides with another entry, DB or same-batch
                Loop->>Loop: conflicts.push(case-insensitive collision); next row
            end
        end
        Loop->>Candidate: entries.get(row.path)
        Loop->>Rules: decideLocalChange(row, existingEntry)
        alt conflict
            Loop->>Loop: conflicts.push({path, reason}); next row
        else noop
            Loop->>Loop: handledPaths.set(path, existingEntry.state_version); next row
        else apply, row.type != "file" (symlink/dir)
            Loop->>Candidate: entriesRepo.upsert({hash:null, ...})
            Loop->>Loop: handledPaths.set(path, versionStamp); appliedCount++; next row
        else apply, row.type = "file"
            alt same hash already in flight this batch
                Loop->>Loop: attach to existingJob.sourceRows; no upload of its own
            else
                Loop->>Mirror: mirrorObjectExists(mirrorObjectPath(hash), encryptedSize)?
                Loop->>Candidate: objectsRepo.has(hash)?
                alt known to S3 AND mirror doesn't need it
                    Loop->>Candidate: entriesRepo.upsert({hash, ...})
                    Loop->>Loop: dedupedObjects++; handledPaths.set(...); appliedCount++; next row
                else verifyRemote enabled AND not already known locally
                    Loop->>S3: headObject(objectKey(hash))
                    alt found, with a recorded checksum
                        opt mirror doesn't need it either
                            Loop->>Candidate: objectsRepo.upsert(...); entriesRepo.upsert(...)
                            Loop->>Loop: dedupedObjects++; appliedCount++; next row
                        end
                        note over Loop: else: remoteChecksum kept, dispatch below only needs the mirror
                    else found, but with no recorded checksum
                        Loop->>Loop: decline the shortcut -- fall through to a real re-upload
                    end
                end
                Loop->>Loop: resolveHashTargetClass([row.path], policies) -- from this row's<br/>path alone, not re-resolved for a later same-batch dedup attach
                Loop->>Loop: waitForRoom(streamPool); dispatchTracked(job) -- see below
            end
        end
    end
```

## Sequence — the dispatched job: tee, retry budgets, checksum accounting

One job per distinct content hash; every same-batch dedup row rides on it via `job.sourceRows`.
Delegates the actual streaming to [`flow-encrypt-stream.md`](flow-encrypt-stream.md) and
[`flow-put-object-stream.md`](flow-put-object-stream.md), and its outer retry to
[`flow-s3-retry.md`](flow-s3-retry.md).

```mermaid
sequenceDiagram
    participant Job as dispatched job
    participant FS
    participant Codec as encryptStream
    participant Tee as teeStream
    participant S3
    participant Mirror as mirror (fs)
    participant Candidate as candidate.db

    Job->>Job: needsS3 = !alreadyOnS3 && remoteChecksum===undefined<br/>mirrorTarget = mirrorNeedsObject ? target : undefined

    loop withMirrorRetry(withS3Retry(runUnit)) -- one "attempt"
        Job->>FS: statSync(absolutePath); compare size/mtime to the scanned row
        opt changed since scanned
            Job--xJob: throw -- row stays dirty, not stored under a stale hash
        end
        Job->>FS: createReadStream (counted via countingReadable)
        Job->>Codec: encryptStream(source, size, masterKey, context, {expectedHash: hash})
        alt needsS3 AND mirrorTarget defined
            Job->>Tee: teeStream(encryptedStream, onMaxRetries="ignore" ? "detach-secondary" : "abort-both")
            par uploadTo(primary)
                Tee->>S3: putObjectStream(..., targetClass) -> ciphertextChecksum
            and mirrorTo(secondary)
                Tee->>Mirror: writeMirrorStream -> wroteMirror=true
            end
            Job->>Job: Promise.allSettled([upload, mirror]); rethrow whichever rejected
        else needsS3 only
            Job->>S3: uploadTo(encryptedStream) -- putObjectStream(..., targetClass)
        else mirrorTarget only (S3 already had the bytes)
            Job->>Mirror: mirrorTo(encryptedStream)
        else neither (ignore-mode fallback, both sinks already satisfied)
            Job->>Job: encryptedStream.destroy() -- source still must be drained
        end
    end

    alt attempt raised MirrorWriteError AND onMaxRetries="fail"
        Job--xJob: throw MirrorRequiredError(paths, hash, cause)
        note over Job: NOT swallowed -- escapes the outer catch below uncaught,<br/>into dispatchTracked's error box, and from there throwIfPoolErrored()<br/>aborts the whole applyLocalChangesToCandidate call once the pool<br/>drains. See flow-pool-dispatch.md.
    else attempt raised MirrorWriteError AND onMaxRetries="ignore" AND ciphertextChecksum is set
        Job->>Job: mirrorFailures++ -- S3 already has it, verified; mirror stays behind for catchup
    else attempt failed for any other reason
        Job->>Job: ciphertextChecksum=undefined; wroteMirror=false<br/>fileTracker.abort(); inFlightByHash.delete(hash)
        Job->>Job: failed.push({path, hash, error}) for each row in job.sourceRows
        note over Job: swallowed here -- every row riding on this job stays dirty,<br/>but no longer silently: `failed` is what SyncResult/--json surface
    end

    alt ciphertextChecksum is set
        Job->>Candidate: objectsRepo.upsert({hash, s3_key, size, ciphertext_checksum})
        loop each row in job.sourceRows
            Job->>Candidate: entriesRepo.upsert({path, type, hash, state_version})
            Job->>Job: handledPaths.set(path, versionStamp); appliedCount++
        end
        Job->>Job: fileTracker.finish()
    else
        note over Job: nothing committed -- handledPaths/appliedCount/entriesRepo untouched
    end
```

## Notes

- **Storage class is resolved once per dispatch, from the storage policies loaded at the top of the
  whole function** (`StoragePoliciesRepository.listNonDefaultByPriority()`/`getDefault()` -- one query
  pair for the entire run, not per row) -- `resolveHashTargetClass([row.path], ...)`, the same function
  `status`/`converge` use. A same-batch dedup attach that arrives after dispatch rides on the class
  already chosen for the row that actually dispatched the job; it is never re-resolved for the attach's
  own path. `converge` remains the authority for correcting a shared object's policy disagreement, or a
  policy edited after the fact -- this only ever affects a genuinely new upload, never a dedup hit
  (`objectsRepo.has(hash)`, keeps whatever class that object already has) or a `--verify-remote`
  adoption (keeps the class it was written with). See
  [`storage-class-policies.md`](../architecture/storage-class-policies.md).
- **Concurrency:** Pass 1 has none. In Pass 2, only the upload/mirror job is dispatched to
  `streamPool`, bounded by `streamQueueLimit` via `waitForRoom` (see
  [`flow-pool-dispatch.md`](flow-pool-dispatch.md)). Inside one job, the tee's two branches
  (`uploadTo`/`mirrorTo`) genuinely run concurrently — one read, one encryption, two sinks advancing in
  lockstep, so S3 goes no faster than the mirror.
- **Two independent retry budgets, nested deliberately:** `withMirrorRetry` is outermost and wraps
  `runUnit`, which is itself `withS3Retry` around the actual read-encrypt-write. The budgets stay
  separate because S3's is unbounded and its retryable errnos include `ETIMEDOUT`/`ENETUNREACH` —
  exactly what a dropped SMB mount throws, so folding a mirror failure into S3's own retry loop would
  give a flaky mount an unbounded number of attempts too. Either way, the retriable unit is the whole
  read-encrypt-write, since a `Readable` that already errored can't be replayed: a retried attempt
  re-reads from byte zero, and hands the abandoned partial back via `fileTracker.retrying()` so the
  progress bar rewinds to what was actually committed.
- **The tee's failure mode is chosen per-attempt from `mirror.onMaxRetries`**: `"ignore"` uses
  `detach-secondary` (S3 finishes regardless of a mirror failure); `"fail"` (the default) uses
  `abort-both` (the whole object is abandoned together). Passing no mode at all silently defaults to
  `abort-both` for both — a bug this branch fixed, since it meant `detach-secondary` was reachable in
  the type system but never actually selected.
- **On failure:** a failed attempt resets `ciphertextChecksum` and `wroteMirror` explicitly in the
  outer catch, precisely because an orphaned, still-running `uploadTo` promise (abandoned by
  `Promise.all`, not `allSettled`) could otherwise set the shared variable _after_ the retry loop had
  already moved on to a new attempt — leaking one attempt's success into another's bookkeeping. Every
  row riding on an ordinary failed job — the dispatcher and every same-batch dedup attach alike — is
  left dirty in `cache.db`; nothing here throws out of the dispatched job itself for that case
  (swallowed and logged), so one bad file cannot take down the rest of the batch.
- **The one exception: `MirrorRequiredError` is deliberately NOT swallowed.** Checked first, ahead of
  every other branch in the outer catch, and rethrown uncaught. Under `--on-mirror-max-retries fail`, a
  mirror write failure is not a per-object failure this row can just stay dirty over — nothing in the
  whole batch may commit without every mirror write succeeding, so it has to abort
  `applyLocalChangesToCandidate` itself, not just this one job. This is what fixed the case where a
  same-batch rename (delete + create sharing one hash the mirror was missing) used to split in half:
  the delete committing while the create's mirror-only write failed and stayed dirty. See
  `src/fs/mirror-sink.ts`'s own doc comment on the class.
- **A row is only ever recorded as applied at its actual point of success** — never at decision time —
  except the two branches with no async gap between deciding and writing (non-file rows, and a clean
  dedup hit), which record it immediately since nothing can fail in between.
- **Sub-flows:** [`flow-pool-dispatch.md`](flow-pool-dispatch.md) (the stream pool dispatch itself),
  [`flow-encrypt-stream.md`](flow-encrypt-stream.md) (the chunked AEAD and its `expectedHash` abort
  seam), [`flow-put-object-stream.md`](flow-put-object-stream.md) (the S3 PUT/multipart branch and
  checksum verification), [`flow-s3-retry.md`](flow-s3-retry.md) (the unbounded outer retry).
