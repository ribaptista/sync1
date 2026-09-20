import type { S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";
import { getObject, putObjectCas } from "../s3/client.js";
import { withS3Retry, type RetryOptions } from "../s3/retry.js";

/**
 * Moves `/current` to this run's version stamp -- the single atomic moment
 * a vault actually commits. Everything before it is idempotent preparation:
 * content objects live at `objects/<hash>` and the snapshot at
 * `states/<stamp>`, so re-writing either is harmless. This one write is not
 * idempotent, which is why it gets its own module rather than a plain
 * `withS3Retry` wrapper at the call site.
 *
 * **The problem with retrying a CAS blindly.** If the PUT reaches S3 and
 * succeeds but its *response* is lost, the retry re-sends `If-Match` against
 * an ETag that is now stale -- because we ourselves replaced it. S3 answers
 * 412, and a commit that genuinely landed gets reported as a conflict with
 * some other machine.
 *
 * **The fix is to ask.** On any failure, read `/current` back. If it already
 * holds this run's own stamp then the PUT landed and the commit is complete,
 * whatever the client saw. Only this run can have written that value:
 * `generateVersionStamp()` is an ISO timestamp plus four random bytes, so no
 * other machine could produce it.
 *
 * **The alternative would not have been unsafe, just wasteful.** A
 * spuriously-reported conflict self-heals on the next run -- the dirty rows
 * re-evaluate against a state.db that now holds this machine's own commit,
 * and every one of them resolves as a no-op via the leniency rules in
 * conflict-rules.ts (see docs/architecture/conflict-resolution.md's
 * "crash recovery self-heals" section, which is this exact scenario). But
 * self-healing costs a whole extra run, and the point of retrying at the
 * commit point is that by then the expensive part is already paid for.
 *
 * The read-back runs on *every* failure, including a genuine `CasConflict`
 * on the very first attempt where it cannot possibly be ours. That costs one
 * small GET in a case that is already headed for a full re-run, and it buys
 * a function with no attempt-number special-casing to get wrong.
 *
 * Throws `CasConflictError` when the pointer genuinely moved under us; the
 * caller maps that to its own domain error.
 */
export async function commitCurrentPointer(
  s3: { client: S3Client; bucket: string },
  currentKey: string,
  versionStamp: string,
  ifMatch: string,
  logger: Logger,
  /** Forwarded verbatim to `withS3Retry` -- `onRetry` in production, an instant `sleep` in tests. */
  retry: RetryOptions = {},
): Promise<void> {
  const pointerAlreadyOurs = async (): Promise<boolean> => {
    const pointer = await getObject(s3.client, s3.bucket, currentKey);
    return pointer?.body.toString("utf8") === versionStamp;
  };

  await withS3Retry(async () => {
    try {
      await putObjectCas(s3.client, s3.bucket, currentKey, Buffer.from(versionStamp, "utf8"), {
        ifMatch,
      });
    } catch (err) {
      // A transient failure of *this* read propagates instead, which is
      // the right outcome: withS3Retry sees it, waits, and the whole
      // commit attempt is tried again from the top.
      if (await pointerAlreadyOurs()) {
        logger.debug(
          { versionStamp },
          "CAS reported a failure but /current already holds this run's stamp -- the commit landed",
        );
        return;
      }
      throw err;
    }
  }, retry);
}
