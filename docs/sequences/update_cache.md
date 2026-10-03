# `sync1 update_cache`

**Derived from:** `src/commands/update_cache.ts`, `src/fs/update-cache.ts`

Refreshes `cache.db` to match the local filesystem: a **sorted merge-join** between the filesystem walk
and `cache.db`'s own sorted entries, advancing both sides in lockstep by path comparison. Needs no
password — it never touches encrypted content, and the local `state.db` it consults is opened
read-only, purely to validate a stub's self-declared hash against known objects. Serves both the
standalone command and, identically, [`sync.md`](sync.md)'s own scanning phase — `performUpdateCache`
is the same function either way. Like every command below, this runs after the ordinary lock/
root-resolution preamble (see [`flow-preamble.md`](flow-preamble.md)), omitted from the diagram below
since it never varies.

## Sequence — the merge-join

```mermaid
sequenceDiagram
    participant Loop as merge-join loop
    participant FS
    participant Cache as cache.db
    participant State as state.db (read-only)
    participant Staging as staging.db (temp)
    participant Hash as hash pool

    Loop->>Loop: start enumerateUpdateCacheWork -- NOT awaited, see flow-enumeration-pass.md

    loop while either cursor has entries left
        alt fs-only path (new locally)
            alt matches an ignore policy
                Loop->>Loop: stats.ignored++ -- never staged at all
            else
                Loop->>Loop: assertStubbableRealFile -- real file only; throws FilenameTooLongForStubError<br/>and aborts the whole run if the name leaves no room for a future ".stub"
                Loop->>Loop: classifyContent (dir / stub / real-or-dangling-both)
                alt resolved synchronously (dir, or a valid stub)
                    Loop->>Staging: staging.insert({state:"created", ...})
                else needs a real hash
                    Loop->>Hash: dispatchHash -- see flow-pool-dispatch.md (BoundedTaskTracker variant)
                    Hash-->>Staging: onResolved(hash) -> staging.insert({state:"created", ...})
                end
            end
        else cache-only path (gone from disk)
            alt cache row already 'deleted' (a pending tombstone)
                Loop->>Loop: idempotent no-op, not re-counted
            else
                Loop->>Staging: staging.insert({state:"deleted", ...}) -- parent_state_version carried over, never re-stamped
                Loop->>Loop: stats.deleted++
            end
        else path in both
            alt cache row is uncommitted ('created') AND now matches an ignore policy
                Loop->>Cache: cacheRepo.delete(path) -- immediate, not staged
                Loop->>Loop: stats.droppedIgnored.push(path)
            else
                Loop->>Loop: assertStubbableRealFile -- same check as the fs-only branch above,<br/>run once up front for every sub-case below
                alt type = dir
                    alt cache row was 'deleted' (recreated)
                        Loop->>Staging: staging.insert({state:"created", ...})
                    else
                        Loop->>Loop: stats.unchanged++
                    end
                else mtime unchanged AND not a dangling stub
                    Loop->>Loop: stats.unchanged++ -- never rehashed
                else
                    Loop->>Loop: classifyContent
                    alt resolved synchronously (a valid stub)
                        Loop->>Loop: finalize(hash, size) -- see below
                    else needs a real hash
                        Loop->>Hash: dispatchHash
                        Hash-->>Loop: onResolved(hash) -> finalize(hash, size)
                    end
                end
            end
        end
    end

    Loop->>Hash: await hashJobs.onIdle() -- every dispatched hash must have inserted<br/>its row (or thrown) before collision detection can trust staging
    Loop->>Loop: control.stop = true; await enumeration (see flow-enumeration-pass.md)
```

`finalize(newHash, size)` (used for an existing path whose content was re-resolved): if the hash is
unchanged, only `mtime` is refreshed and the row's existing `state` is preserved (`stats.unchanged++`);
otherwise a genuinely new pending change is staged — `created`→`modified` transition only if the row was
`unchanged`/`deleted`, otherwise the existing pending `state` is kept and just its hash/mtime/size are
refreshed (content changed again before syncing).

## Sequence — case-collision detection and the apply pass

Deferred to a second pass over the whole batch — `better-sqlite3` refuses another statement on the same
connection while a live `.iterate()` cursor is open, and, independently, a row later found to collide
must never have been written to `cache.db` at all.

```mermaid
sequenceDiagram
    participant Loop as performUpdateCache
    participant Staging as staging.db
    participant Cache as cache.db

    Loop->>Staging: liveCollisionGroups() -- normalized paths staged more than once, this batch
    loop each group
        Loop->>Loop: excludedPaths.add(...) for every row but one; collisions.push(...)
    end
    loop every staged row not excluded and not 'deleted'
        Loop->>Cache: findByNormalizedPath(collision key) -- against cache.db's own durable rows
        alt hit, and that hit is NOT also tombstoned in this same batch
            Loop->>Loop: excludedPaths.add(row.path); collisions.push(...) -- a real collision, not a rename
        end
    end

    Loop->>Staging: iterateAll() (keyset-paginated)
    loop each row not in excludedPaths
        Loop->>Cache: batch.push(row); flush every 500 rows -- cacheRepo.transaction(upsert each)
    end
    Loop->>Staging: close(); rm staging.db(-wal/-shm)
```

## Output

```json
{
  "ok": true,
  "created": 2,
  "modified": 1,
  "deleted": 0,
  "unchanged": 40,
  "ignored": 3,
  "dropped_ignored": [],
  "case_collisions": []
}
```

`ok` is `false` whenever `case_collisions` is non-empty — a collision means the colliding paths were
never applied to `cache.db` at all (only counted), so they need renaming and a re-run.

## Notes

- **Concurrency:** the merge-join itself is fully sequential; only actual hashing is dispatched, to
  `hashRunner`/`BoundedTaskTracker` (see [`flow-pool-dispatch.md`](flow-pool-dispatch.md)), bounded by
  `maxInFlightHashes`. A second, independent enumeration walk runs concurrently purely to seed the
  progress bar's denominator (see [`flow-enumeration-pass.md`](flow-enumeration-pass.md)).
- **A stub's declared hash is validated, never trusted blindly**: `classifyContent` looks it up in the
  (read-only) local `state.db`'s `objects` table, and throws `UnknownStubContentError` (a
  `CorruptionError`) if it references a hash this vault has never actually backed up.
- **A dangling stub (both a stub and the real file present) always resolves to the real file** — the
  stray stub is deleted as a side effect of classification, not left to keep resurfacing on every future
  scan.
- **An ignore policy never retroactively un-tracks committed content.** It is checked in two different
  places for two different reasons: a brand-new local path matching one is simply never staged
  (`ignored`); an already-committed path (`unchanged`/`modified`) is never even considered against the
  glob list at all, since dropping its cache row would propagate as an indistinguishable local delete to
  every other machine on the next sync. Only an **uncommitted** (`created`) row can still be dropped this
  way, and it is applied immediately rather than staged (`droppedIgnored`).
- **`parent_state_version` is always carried over from the existing row, never re-stamped with this
  run's own `lastSyncedVersion`**, for any transition on an already-known path (including a fresh
  tombstone). Only a genuinely brand-new path gets `lastSyncedVersion` as its baseline. This is the
  invariant `conflict-rules.ts` depends on — see
  [`flow-apply-local-changes.md`](flow-apply-local-changes.md).
- **On failure:** a thrown error (a corrupt stub, an unknown-object stub reference, a real file's name
  leaving no room for a future `.stub` suffix (`FilenameTooLongForStubError`), a hash job's own failure)
  propagates out of the merge-join loop; the enumeration pass is still cut short and joined in the
  `finally`, and the staging DB is still closed and removed — nothing durable in `cache.db` itself has
  been touched yet, since every write is deferred to the apply pass after the loop. The name-length check
  runs synchronously, before `classifyContent`/hashing, so it's the cheapest possible rejection for an
  offending path.
- **Sub-flows:** [`flow-pool-dispatch.md`](flow-pool-dispatch.md) (the `BoundedTaskTracker` hash
  dispatch), [`flow-enumeration-pass.md`](flow-enumeration-pass.md) (the concurrent estimate walk).
