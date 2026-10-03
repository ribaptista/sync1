# `sync1 thumbnail state|ensure|cleanup`

**Derived from:** `src/commands/thumbnail.ts`, `src/fs/thumbnail.ts`

All three subcommands share one function, `scanThumbnails`, parameterized only by
`ThumbnailRunMode = "state" | "ensure" | "cleanup"` — never three separate code paths. Local-only, no
password or S3 client: `cache.db` and `state.db` are opened **read-only** (this command never writes
either), only the local filesystem is touched (a `_thumbnail/` file written or deleted). `state` writes
nothing at all; `ensure` only generates (never deletes an extra); `cleanup` only deletes (never
generates) — a single `mode` check at each of the few points that actually act. Runs after the
ordinary lock/root-resolution preamble (see [`flow-preamble.md`](flow-preamble.md)), omitted below since
it never varies.

A thumbnail's filename encodes its own identity and generation parameters —
`<original-name>.<params-segment>.<content-hash>.<ext>` — so a policy config change or a source edit
naturally produces a different expected filename with no separate regeneration-detection mechanism: a
mismatched expected filename just reads as "not up to date" through the same reconciliation this file
already needs.

## Sequence — top-level orchestration (three walks)

```mermaid
sequenceDiagram
    participant CLI as thumbnail command
    participant Estimate as estimate walk
    participant Main as authoritative walk
    participant Pool as thumbnail pool
    participant Sweep as orphan sweep

    CLI->>Estimate: start enumerateThumbnailWork -- NOT awaited (same shape as flow-enumeration-pass.md,<br/>but hand-rolled here rather than sharing that helper)

    loop each file under walkRoot (or --glob's literal-prefix subtree)
        Main->>Main: skip: under _thumbnail/, doesn't match --glob, or matches an ignore policy
        alt hasMatchingSkipGlob(path, policies) -- wins outright, glob alone, no probe
            Main->>Main: representation=stub: processStubSource(...) (unchanged, just not counted)
            Main->>Main: representation=real/both: discardThumbnailsFor(...) -- toDelete++ per existing<br/>sibling thumbnail (deleted only in cleanup); NOT counted as a progress unit either way
        else no thumbnail policy's glob matches at all
            Main->>Main: skip (not a candidate)
        else shouldProcessSource(mode, hash, policies)
            alt mode=ensure AND already has every expected thumbnail file
                Main->>Main: stats.upToDate++ per matching policy already present; skip
            else representation = "stub"
                Main->>Main: discoveredOne(); processStubSource(...) -- see below, fully synchronous, no pool; completedOne()
            else representation = "real" or "both" (dangling stub)
                Main->>Main: discoveredOne()
                Main->>Pool: waitForRoom; dispatchTracked(job) -- see below; completedOne() in job's finally
            end
        end
    end

    Main->>Pool: await pool.onIdle(); throwIfPoolErrored()
    Main->>Sweep: sweepUnprocessedThumbnails -- a THIRD walk, for existing _thumbnail/<br/>entries whose original no longer exists or was excluded by glob/ignore/policy<br/>(isSweepOrphan, the inverse of the old sourceWasProcessed check)
    Note over Sweep: mode=cleanup: discoveredOne()/completedOne() per orphan (real, countable work --<br/>removeIfCleanup actually deletes). mode=ensure/state: stats.toDelete++ only, no progress-unit cost<br/>(removeIfCleanup is a no-op there) -- see #40
    CLI->>Estimate: control.stop = true; await estimation
```

`enumerateThumbnailWork` mirrors every one of these gates with zero I/O beyond what it already does
(`hasMatchingSkipGlob` before `shouldProcessSource`, same order as the real walk), so its estimate never
counts a skip-glob match either, and -- under `cleanup` only -- separately predicts the sweep's own
prospective orphans via the same `isSweepOrphan` check, so its total matches `cleanup`'s real final total
from the start instead of growing once the sweep runs. See #29/#40.

## Sequence — per-source dispatch

```mermaid
sequenceDiagram
    participant Job as dispatched job
    participant Prober as MediaProber
    participant Recon as reconcileProbedSource
    participant Gen as ThumbnailGenerator
    participant FS

    alt stub source (processStubSource)
        Job->>Job: cacheHash === null? -> stats.missingCacheEntry++; done
        Job->>FS: forEachThumbnailForOriginal -- opendir the sibling _thumbnail/, parse each name
        alt an existing thumbnail's hash matches the stub's OWN declared hash
            Job->>Job: stats.stubbedPreserved++; every OTHER thumbnail for this original -> stats.toDelete++<br/>(deleted only in cleanup mode)
        else no thumbnail exists at all yet
            Job->>Job: stats.stubbedOriginal++ -- nothing to preserve, nothing generatable (no real bytes to probe)
        else thumbnails exist but none match the stub's hash
            Job->>Job: every one -> stats.staleStubPreviews.push(...) -- NEVER auto-deleted<br/>unless mode=cleanup AND --delete-stale-stub-previews
        end
    else real/dangling-both source (dispatched to the pool -- a skip-glob match never reaches here,<br/>resolved inline in the main loop before dispatch, see the orchestration diagram above)
        Job->>Prober: classifyProbed -> prober.detectMedia(absolutePath)
        alt unreadable
            Recon->>Recon: stats.unreadable++ -- logged, existing thumbnails left untouched (never swept)
        else readable, but no 'generate' policy's glob+mimeType matches (resolvePolicies only<br/>ever returns a 'generate' match now -- 'skip' is resolved before this is ever reached)
            Recon->>FS: discardThumbnailsFor -- every existing thumbnail for this original -><br/>stats.toDelete++ (deleted only in cleanup)
        else one or more 'generate' policies matched
            alt decision.cacheHash === null (no cache.db row at all)
                Recon->>Recon: stats.missingCacheEntry++
            else
                Recon->>Recon: per-policy reconciliation -- see state machine below
            end
        end
    end
```

## Sequence — per-policy reconciliation state machine

One source can match several `generate` policies at once (each producing its own output, never
competing) — this runs once per matched policy, classifying every existing sibling thumbnail that names
that policy against the freshly-computed expected identity.

```mermaid
sequenceDiagram
    participant Recon as reconcileProbedSource
    participant Gen as ThumbnailGenerator
    participant FS

    loop each existing thumbnail naming this policy
        alt hash + ext + params segment all match what's expected NOW
            Recon->>Recon: state.exact = thumbnail (first one wins; any later "exact" duplicate is deleted)
        else no exact match claimed yet, and no stale one held yet
            Recon->>Recon: state.stale = thumbnail (candidate to regenerate-over)
        else
            Recon->>Recon: a genuine extra -- stats.toDelete++ (cleanup only)
        end
    end

    alt state.exact is set
        Recon->>Recon: stats.upToDate++
    else state.stale is set (a regeneration)
        Recon->>Recon: stats.toRegenerate++
        opt mode = "ensure"
            Recon->>Gen: generateForDecision(..., staleThumbnail: state.stale)
            Gen->>Gen: fitsWithStubSuffix(destBasename)? else throw ThumbnailGenerationError -- before any mkdir/render/generator work
            Gen->>FS: mkdirSync(dirname); render to inTreeTempPathPreservingExtension(dest)
            Gen->>FS: fs.renameSync(temp, dest) -- see flow-atomic-publish.md (no renameWithRetry here)
            Gen->>FS: THEN delete state.stale -- the old file is only removed after the new one lands
            alt ThumbnailGenerationError
                Gen-->>Recon: stats.errors++; logged, run continues (per-file failure)
            end
        end
    else neither (brand new)
        Recon->>Recon: stats.toGenerate++
        opt mode = "ensure"
            Recon->>Gen: generateForDecision(..., staleThumbnail: undefined) -- same publish sequence, no old file to remove
        end
    end
```

## Output

```json
{
  "ok": true,
  "up_to_date": 40,
  "to_generate": 2,
  "to_regenerate": 1,
  "to_delete": 0,
  "missing_cache_entry": 0,
  "stubbed_original": 3,
  "stubbed_preserved": 1,
  "stale_stub_previews": [],
  "errors": 0,
  "unreadable": 0
}
```

`ok` is `false` whenever `errors > 0` (a per-file generation failure) or `stale_stub_previews` is
non-empty (an unregenerable preview sitting there, needing a human decision).

## Notes

- **Concurrency:** only the "real/dangling-both" branch dispatches to `pool` (bounded by
  `poolQueueLimit`, see [`flow-pool-dispatch.md`](flow-pool-dispatch.md)) — a stub source resolves
  entirely synchronously, no probe or generation possible without real bytes. The estimate walk runs
  concurrently with the authoritative walk, same pattern as
  [`flow-enumeration-pass.md`](flow-enumeration-pass.md) (hand-rolled here rather than sharing that
  exact helper, since thumbnail's own per-row predicate differs).
- **A skip-glob match is resolved inline, in the main loop itself, before dispatch** —
  `hasMatchingSkipGlob` wins outright over any coexisting generate match (same precedent as
  `resolvePolicies`'s own skip-wins-outright rule), costing nothing beyond the glob match itself: no
  `prober.detectMedia()` call, and not counted as a progress unit in either walk. A real file's existing
  sibling thumbnails are cleared via `discardThumbnailsFor` (shared with the "no 'generate' policy
  matches" branch below); a stub still goes through `processStubSource` unchanged, just uncounted. See
  #29/#40 for the bug this fixed (a skip-matched tree used to be fully probed, and the estimate
  undercounted by however many such files existed).
- **The trailing orphan sweep only costs a progress unit under `cleanup`** — `ensure`/`state` still
  tally `stats.toDelete` for every orphan `isSweepOrphan` finds, but never call `discoveredOne`/
  `completedOne` for one, since `removeIfCleanup` is a no-op in those modes and counting a unit for zero
  real work is what used to make the bar's total keep growing right as a run looked finished (#40). The
  estimate walk mirrors this: it predicts `cleanup`'s own prospective orphans (same `isSweepOrphan`
  check, no extra I/O), but never does for `ensure`/`state`.
- **A stale stub preview is never auto-deleted**, even under `cleanup`, unless
  `--delete-stale-stub-previews` is also passed. It is the _last remaining copy_ of a preview whose
  source can no longer be read (a stub, by definition) to regenerate from — deleting it destroys
  something unrecoverable without first materializing the original.
- **An unreadable source's existing thumbnails are never swept, in any mode** — the same
  "unregenerable, so never destroyed without an explicit opt-in" precedent as stale stub previews, just
  with no flag to override it at all (an unreadable _real_ file's own bytes might still exist to fix, so
  this is more conservative, not less).
- **A stub source's reconciliation does not track per-policy identity the way a real source's does.**
  `processStubSource` keeps at most **one** existing thumbnail total (the first one it encounters whose
  hash matches the stub's own declared hash) and counts every other thumbnail for that original as
  `toDelete` — even one produced by a _different_ `generate` policy that also legitimately matches the
  stub's hash. A stub cannot be probed for its mime type (no real bytes), so there is no way to resolve
  which policy each sibling thumbnail belongs to the way `reconcileProbedSource`'s `policiesByName` map
  does for a real source; this is a real, narrower guarantee for a stubbed original with more than one
  matching `generate` policy, not an oversight in this documentation.
- **A newly-ignored path's thumbnails are never explicitly deleted either** — they simply stop being
  claimed by the authoritative walk, so they fall through to `sweepUnprocessedThumbnails`'s ordinary
  unclaimed-orphan handling like any other orphan, counted under `toDelete`.
- **Publish-then-delete ordering, generation's own crash safety:** the new thumbnail is written to a
  temp sibling and renamed into place _before_ a stale one it's replacing is deleted — an interrupted
  regeneration never leaves zero valid thumbnails for a policy that already had one.
- **On failure:** a per-file `ThumbnailGenerationError` (unwritable destination, a name too long for the
  filesystem, a name that fits the filesystem but leaves no room for a future `.stub` suffix, an
  unsupported source) is caught, counted (`stats.errors`), logged with the path, and the run continues —
  it never aborts the whole scan. Any _other_ thrown error (a probe crash, a real fs error outside
  generation) propagates out of the dispatched job to `throwIfPoolErrored`, ending the run.
- **Sub-flows:** [`flow-pool-dispatch.md`](flow-pool-dispatch.md) (the per-source dispatch),
  [`flow-atomic-publish.md`](flow-atomic-publish.md) (thumbnail publish — the bare-`renameSync` variant,
  not `renameWithRetry`).
