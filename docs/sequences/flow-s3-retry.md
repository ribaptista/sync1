# Flow: `withS3Retry`'s unbounded backoff

**Derived from:** `src/s3/retry.ts`

**Used by:** [`sync.md`](sync.md) (via [`flow-apply-local-changes.md`](flow-apply-local-changes.md) and
[`flow-apply-remote-changes.md`](flow-apply-remote-changes.md)),
[`materialize.md`](materialize.md)

**Deliberately not used by:** `gc.md`, `converge_status.md`, `policy_edit.md` — see below.

`withS3Retry` wraps a whole operation (a GET, a PUT, or — in the upload/download paths — an entire
read-encrypt-transfer unit) and retries it **forever** on a fixed set of transient AWS SDK error names,
node socket/DNS errnos, and HTTP status codes, with exponential backoff capped at a maximum delay. There
is no attempt limit: a backup tool waiting out a long outage is judged better than one that gives up and
loses six hours of upload progress.

## Sequence

```mermaid
sequenceDiagram
    participant Caller
    participant Retry as withS3Retry
    participant S3

    Caller->>Retry: withS3Retry(operation, { onRetry })
    loop attempt = 1, 2, 3, ... (no upper bound)
        Retry->>S3: operation()
        alt succeeds
            S3-->>Retry: result
            Retry-->>Caller: result
        else transient error (network/DNS errno, 429/500/502/503/504,<br/>NetworkingError, TimeoutError, SlowDown, ...)
            S3-->>Retry: throws
            Retry->>Caller: onRetry(notice) -- attempt, delayMs, elapsedMs
            Retry->>Retry: sleep(delay); delay = min(delay * 2, MAX_DELAY_MS)
        else non-transient error (anything not on the list --<br/>auth failures, CasConflictError, CorruptionError, ...)
            S3-->>Retry: throws
            Retry-->>Caller: rethrow immediately, no retry
        end
    end
```

## Notes

- **Concurrency:** none of its own — one caller, one operation in flight. Concurrency comes from
  whatever pool the caller itself runs inside (see [`flow-pool-dispatch.md`](flow-pool-dispatch.md)).
- **On failure:** a non-transient error propagates on the very first attempt, unchanged from before this
  wrapper existed. A transient error is invisible to the caller until either it stops happening or the
  process is killed (Ctrl-C is the intended escape hatch for "I've decided this outage isn't ending").
- **Why some callers deliberately avoid it:**
  - `gc.ts`'s CAS loop and `mutateStateDb`'s CAS loop each have their **own** bounded retry (5 attempts,
    re-fetching and recomputing from scratch on each — see
    [`flow-cas-commit.md`](flow-cas-commit.md)) with a different failure semantics: a `CasConflictError`
    means _another commit landed first_, which is answered by recomputation, not by waiting out a
    network blip. Wrapping that loop's own S3 calls in an _additional_, unbounded retry would make a
    genuinely stuck five-attempt loop indistinguishable from a healthy one still working through
    transient errors.
  - `converge`/`status` HEAD/copy/restore calls have no retry wrapper at all — a transient failure there
    simply fails that one object's dispatched job, counted as a pool error, and the command reports what
    it managed before the failure. This is a plainer, less resilient design than sync's, and nothing in
    the code notes why; it is stated here because the asymmetry is otherwise invisible.
- **Visibility:** because a retry loop looks identical at minute one and at minute sixty, `onRetry`
  always carries both the attempt count and elapsed time, and every caller logs it — the diagram in
  [`sync.md`](sync.md) shows exactly where those log lines land relative to the progress bar (fd 3).
- **Sub-flows:** none.
