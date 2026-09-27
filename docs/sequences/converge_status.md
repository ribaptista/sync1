# `sync1 converge` / `sync1 status`

**Derived from:** `src/commands/converge.ts`, `src/commands/status.ts`, `src/sync/converge-storage-policies.ts`

One shared function, `convergeStoragePolicies`, with a single `apply` boolean as the only difference
between the two commands: `status` (`apply: false`) reports what would change; `converge`
(`apply: true`) actually issues the S3 calls. Needs no password — HEAD/copy/restore never decrypt
anything, and storage policies are read from the already-locally-decrypted `state.db` (opened
read-only). Neither uses [`flow-s3-retry.md`](flow-s3-retry.md)'s unbounded retry — a transient failure
here just fails the run; the next `converge`/`status` invocation re-evaluates everything from scratch.
Both run after the ordinary lock/root-resolution preamble (see
[`flow-preamble.md`](flow-preamble.md)), omitted below since it never varies.

## Sequence

```mermaid
sequenceDiagram
    participant CLI as converge / status
    participant State as state.db (read-only)
    participant Pool as s3 pool
    participant S3
    participant Archive as flow-archive-status

    CLI->>State: listNonDefaultByPriority(); getDefault()
    CLI->>State: onTotalKnown(countDistinctHashesMatchingGlob(filter)) -- offline denominator

    loop each DISTINCT hash matching --filter (dedup: one evaluation per object, not per path)
        CLI->>State: iterateByHash(hash) -- every path referencing it, regardless of --filter scope
        CLI->>CLI: resolveHashTargetClass(paths, nonDefaultPolicies, defaultPolicy)
        opt paths disagree on target class
            CLI->>CLI: conflicts.push({hash, paths, targetClass}) -- warmest-wins already resolved it,<br/>this is just surfaced for visibility
        end
        CLI->>State: objectsRepo.get(hash) -- missing -> CorruptionError
        CLI->>Pool: waitForRoom; dispatchTracked(job)
        Pool->>S3: headObject(key)
        Pool->>Archive: currentClass = head.storageClass; classifyArchiveStatus(head)
        Pool->>Pool: decideStorageClassAction(currentClass, targetClass, archiveStatus)
        alt already-correct
            Pool->>Pool: counts.alreadyCorrect++
        else immediate-copy (target is colder, or warmer+already "immediate")
            Pool->>Pool: counts.changedImmediate++
            opt apply
                Pool->>S3: copyObjectStorageClass(key, targetClass)
            end
        else needs-restore-request
            Pool->>Pool: counts.restoreRequested++
            opt apply
                Pool->>S3: restoreObject(key, days:7, tier:Standard)
            end
        else restore-ongoing
            Pool->>Pool: counts.restorePending++ -- no action possible either way
        else finalize-copy (restore-ready)
            Pool->>Pool: counts.finalized++
            opt apply
                Pool->>S3: copyObjectStorageClass(key, targetClass)
            end
        end
        Pool->>CLI: checked++; onProgress(checked)
    end

    CLI->>Pool: await s3Pool.onIdle(); throwIfPoolErrored()
```

## Output

```json
{
  "ok": true,
  "already_correct": 40,
  "changed_immediate": 2,
  "restore_requested": 1,
  "restore_pending": 0,
  "finalized": 0,
  "conflicts": [{ "hash": "ab12...", "paths": ["a.txt", "b.txt"], "target_class": "STANDARD" }]
}
```

Always `ok: true`, for both commands — a warmest-wins conflict is reported, not a failure (the object
already has a deterministic target class; the conflict is informational visibility into _why_). A
thrown error (missing object, unsupported storage class from S3) fails the command outright instead.

## Notes

- **Concurrency:** the outer loop's own work (resolving every path sharing a hash, warmest-wins
  conflict detection, the objects-table lookup) is synchronous SQL, never spanning an `await`. Only the
  per-hash tail — HEAD, classify, conditional copy/restore — is genuine network I/O, dispatched to
  `s3Pool` (see [`flow-pool-dispatch.md`](flow-pool-dispatch.md)).
- **Dedup-aware by construction:** the loop iterates _distinct hashes_, not paths — a shared object's
  target class is resolved from every path referencing it, regardless of `--filter`'s own scope, since
  warmest-wins has to see the whole picture to resolve correctly. See
  `docs/architecture/ignore-and-storage-policies.md`.
- **A colder target is always an unconditional `immediate-copy`** — no archive-status branching needed,
  since moving to a colder class from any current state is always a plain, immediate copy (see
  [`flow-archive-status.md`](flow-archive-status.md)'s notes on `decideStorageClassAction`). Only a
  _warmer_ target branches on the object's current restore status.
- **`status` and `converge` classify identically — the counts `status` reports are exactly what
  `converge --apply` would do**, since both call the same function with the same evaluation; only
  whether the S3 side effect is actually issued differs.
- **On failure:** a missing `objects` row for a referenced hash, a missing S3 object at HEAD time, or an
  unsupported storage class all throw `CorruptionError`/`Error` synchronously inside the dispatched job,
  captured by `dispatchTracked` and surfaced via `throwIfPoolErrored` after `s3Pool.onIdle()` — failing
  the whole command, with no partial per-object reporting.
- **Sub-flows:** [`flow-pool-dispatch.md`](flow-pool-dispatch.md), [`flow-archive-status.md`](flow-archive-status.md).
