/**
 * Retry wrapper for S3 requests that fail for reasons a later attempt could
 * plausibly succeed at -- a dropped link, a read timeout, a throttle.
 *
 * Shaped after `src/fs/safe-fs.ts`'s `withRetry` (module-local constants, a
 * predicate, an exponential backoff loop) with one deliberate difference:
 * **there is no attempt limit**. For a backup tool that is the right call --
 * an upload that dies six hours in because the uplink blipped is worse than
 * one that waits out the outage -- but it moves weight onto three things
 * that would otherwise be incidental:
 *
 * - `MAX_DELAY_MS` becomes load-bearing rather than a nicety. With no
 *   ceiling on attempts it is the only thing stopping the backoff growing
 *   without bound, so the delay climbs to it and then stays there.
 * - Ctrl+C is the escape hatch. `handleTerminationSignal` (src/cli.ts)
 *   force-releases the lock and exits immediately, so a user who decides the
 *   outage isn't ending can always stop.
 * - Visibility stops being cosmetic. A retry loop looks identical at minute
 *   one and minute sixty, so `onRetry` carries the attempt count *and* the
 *   elapsed time -- without those, an indefinite retry is indistinguishable
 *   from a hang.
 *
 * What is *not* retried matters as much as what is: anything not on the
 * transient list below throws on its first occurrence, exactly as before.
 * That includes `CasConflictError` (which has its own retry loops with their
 * own semantics, see mutate-state-db.ts and gc.ts), `CorruptionError`, and
 * every auth/permission failure.
 */

/**
 * AWS SDK error `name`s for conditions that are purely about the transport
 * or about the service asking us to slow down. Deliberately excludes
 * `PreconditionFailed` (CAS conflict -- a real answer, not a failure) and
 * `NoSuchKey`/`NotFound` (also real answers, already mapped to `null` by the
 * client wrappers).
 */
const RETRYABLE_ERROR_NAMES = new Set([
  "NetworkingError",
  "TimeoutError",
  "RequestTimeout",
  "RequestTimeoutException",
  "SlowDown",
  "ThrottlingException",
  "RequestThrottled",
  "RequestThrottledException",
  "InternalError",
  "ServiceUnavailable",
]);

/**
 * Node socket/DNS errnos worth waiting out.
 *
 * `ECONNREFUSED` is deliberately absent, and the asymmetry with `ENOTFOUND`
 * is the point: "the host resolved but nothing is listening" is far more
 * often a misconfigured endpoint or port than a blip, so failing fast is the
 * more useful answer. A DNS failure, by contrast, is the classic symptom of
 * a dropped WiFi/VPN link -- the single most common transient condition this
 * tool will meet -- so it is retried.
 *
 * The cost of that choice, accepted knowingly: a genuinely typo'd endpoint
 * hostname retries forever instead of erroring. Telling "DNS is down" from
 * "this name never existed" would mean tracking whether any request on the
 * client had ever succeeded, and the attempt counter in the progress label
 * makes it obvious within seconds anyway.
 */
const RETRYABLE_ERRNOS = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
]);

/** Throttling and server-side faults. 4xx other than 429 are our problem, not the network's. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** First backoff, doubling from here. Long enough not to hammer a service that just asked us to slow down. */
const BASE_DELAY_MS = 500;

/** Ceiling on the backoff. See the module note: with no attempt limit, this is what bounds the wait. */
const MAX_DELAY_MS = 30_000;

/** How many `cause` links to follow. The SDK wraps socket errors, sometimes more than once. */
const MAX_CAUSE_DEPTH = 5;

function errorName(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "name" in err
    ? String((err as { name: unknown }).name)
    : undefined;
}

function errnoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

function httpStatusCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null || !("$metadata" in err)) return undefined;
  const metadata = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode;
}

/**
 * True if `err` (or anything it wraps) is worth another attempt. Walks the
 * `cause` chain because the SDK routinely reports a socket hang-up as an
 * outer `Error` whose `cause` carries the actual `ECONNRESET`.
 */
export function isTransientS3Error(err: unknown): boolean {
  let current = err;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null;
    depth++
  ) {
    const name = errorName(current);
    if (name !== undefined && RETRYABLE_ERROR_NAMES.has(name)) return true;

    const code = errnoCode(current);
    if (code !== undefined && RETRYABLE_ERRNOS.has(code)) return true;

    const status = httpStatusCode(current);
    if (status !== undefined && RETRYABLE_STATUS_CODES.has(status)) return true;

    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

/** What `onRetry` is told about a failed attempt, before the wait for the next one begins. */
export interface RetryNotice {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  /** Exactly how long `withS3Retry` is about to wait -- already jittered, so a caller can display it verbatim. */
  delayMs: number;
  /** Since the *first* failure of this operation, so a caller can say how long it has been stuck. */
  elapsedMs: number;
  /** The error that caused this retry, for logging. */
  error: unknown;
}

export interface RetryOptions {
  /** Called after each failed attempt, before the wait. */
  onRetry?: (notice: RetryNotice) => void;
  /** Injectable so tests drive the backoff without waiting through it. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Jittered exponential backoff, capped. Jitter spans 50-100% of the capped
 * delay rather than AWS's full 0-100% jitter: it still de-synchronizes the
 * several transfers a pool has in flight, without occasionally reporting
 * "retrying in 0s" and then retrying immediately into the same outage.
 */
function backoffDelayMs(attempt: number): number {
  const uncapped = BASE_DELAY_MS * 2 ** (attempt - 1);
  const capped = Math.min(MAX_DELAY_MS, uncapped);
  return Math.round(capped * (0.5 + Math.random() * 0.5));
}

/**
 * Runs `op`, retrying indefinitely for as long as it fails transiently.
 *
 * `op` is re-invoked from scratch on every attempt, so it must be
 * self-contained: a caller uploading a file has to build a *fresh* read
 * stream inside it, since a stream that already errored can't be replayed.
 */
export async function withS3Retry<T>(op: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let firstFailureAt: number | undefined;

  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (!isTransientS3Error(err)) throw err;
      firstFailureAt ??= Date.now();
      const delayMs = backoffDelayMs(attempt);
      opts.onRetry?.({
        attempt,
        delayMs,
        elapsedMs: Date.now() - firstFailureAt,
        error: err,
      });
      await sleep(delayMs);
    }
  }
}
