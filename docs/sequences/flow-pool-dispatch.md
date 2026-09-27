# Flow: pool dispatch

**Derived from:** `src/concurrency/pools.ts`, `src/concurrency/hash-runner.ts`,
`src/concurrency/hash-worker.ts`

**Used by:** every command file whose command dispatches per-item work to a bounded pool —
[`sync.md`](sync.md) (via [`flow-apply-local-changes.md`](flow-apply-local-changes.md) and
[`flow-apply-remote-changes.md`](flow-apply-remote-changes.md)), [`update_cache.md`](update_cache.md),
[`stubify.md`](stubify.md), [`materialize.md`](materialize.md), [`gc.md`](gc.md),
[`thumbnail.md`](thumbnail.md), [`converge_status.md`](converge_status.md),
[`sanity_check.md`](sanity_check.md)

Every bounded-concurrency loop in the codebase follows one of two idioms, never anything ad hoc. The
`PQueue`-backed idiom (`s3`, `stream`, `thumbnail` pools) is `waitForRoom` → `dispatchTracked` →
`onIdle` → `throwIfPoolErrored`. The Piscina-backed one (`hash` pool) is `BoundedTaskTracker.dispatch` →
`.onIdle()`, which folds backpressure and error capture into one call.

`createConcurrencyPools` always constructs **all four** pools regardless of which ones a command
actually uses (`hash`: Piscina, `maxThreads = --hash-parallelism ?? cpu count`; `s3`/`stream`/`thumbnail`:
`PQueue`, default concurrency 8/4/4). Only `pools.hash.close()` is ever awaited on teardown; the three
`PQueue`s are never explicitly closed.

## Sequence

```mermaid
sequenceDiagram
    participant Producer as producer loop
    participant Pool as PQueue
    participant Job as dispatched job
    participant Box as error box

    rect rgb(240, 240, 240)
    note over Producer,Box: PQueue idiom (s3 / stream / thumbnail pools)
    loop for each item
        Producer->>Pool: waitForRoom(pool, queueLimit)
        Pool-->>Producer: resolves once pool.size < queueLimit
        Producer->>Pool: dispatchTracked(pool, box, jobFn)
        Pool->>Job: jobFn() -- runs concurrently, up to `pool.concurrency` at once
        alt jobFn throws
            Job-->>Box: box.error = box.error ?? err (first error only, kept)
        else jobFn succeeds
            Job-->>Pool: resolved
        end
    end
    Producer->>Pool: await pool.onIdle()
    Producer->>Box: throwIfPoolErrored(box)
    Box-->>Producer: throws box.error if set
    end

    rect rgb(230, 245, 255)
    note over Producer,Job: Piscina idiom (hash pool)
    loop for each item needing a hash
        Producer->>Job: await hashJobs.dispatch(jobFn)
        note right of Job: blocks the producer only when<br/>in-flight count >= maxThreads
        Job->>Job: hashRunner.run(path, onBytes) -- piscina worker thread,<br/>SharedArrayBuffer byte-progress sampling
    end
    Producer->>Job: await hashJobs.onIdle()
    note right of Job: rethrows the first captured task error
    end
```

## Notes

- **Concurrency:** the whole point of this flow — `pool.concurrency` jobs run genuinely at once (real
  OS-level parallelism for the Piscina worker threads; event-loop interleaving for the `PQueue` jobs,
  which are I/O-bound). `waitForRoom`'s queue limit is deliberately looser than the pool's own
  concurrency (commonly `concurrency * 2`), so the producer can stay a little ahead without unbounded
  buffering.
- **On failure:** the `PQueue` box keeps only the **first** error; every other concurrently-running job
  keeps going to completion (or its own failure, silently discarded) before `onIdle()` returns and
  `throwIfPoolErrored` finally raises. A caller relying on "the run stops the instant something fails"
  is wrong — it stops only once the whole in-flight batch drains.
- **A job's own internal catch can pre-empt this entirely.** Several call sites (the upload job in
  `apply-local-changes.ts`, the download job in `apply-remote-changes.ts`) wrap their body in their own
  `try/catch` and deliberately swallow a per-item failure (leaving a cache row dirty, say) rather than
  letting it reach the pool's error box at all — see each command file's own failure notes for which.
- **Sub-flows:** none — this is the leaf idiom other flows point to.
