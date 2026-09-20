import { describe, it, expect, vi } from "vitest";
import { withS3Retry, isTransientS3Error, type RetryNotice } from "../../../src/s3/retry.js";

/** Records every requested delay instead of waiting, so these tests are instant. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

function errnoError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function sdkError(name: string, httpStatusCode?: number): Error {
  const err = Object.assign(new Error(name), { name });
  if (httpStatusCode !== undefined) {
    Object.assign(err, { $metadata: { httpStatusCode } });
  }
  return err;
}

describe("isTransientS3Error", () => {
  it("accepts socket and DNS errnos worth waiting out", () => {
    for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]) {
      expect(isTransientS3Error(errnoError(code))).toBe(true);
    }
  });

  it("accepts SDK transport errors and throttle/server status codes", () => {
    expect(isTransientS3Error(sdkError("NetworkingError"))).toBe(true);
    expect(isTransientS3Error(sdkError("TimeoutError"))).toBe(true);
    for (const status of [429, 500, 502, 503, 504]) {
      expect(isTransientS3Error(sdkError("SomeServiceError", status))).toBe(true);
    }
  });

  it("rejects ECONNREFUSED, deliberately, unlike ENOTFOUND", () => {
    // Not symmetric on purpose: "resolved but nothing listening" is far more
    // often a wrong endpoint or port than a blip, and failing fast is the
    // more useful answer. A DNS failure is the classic dropped-link symptom.
    expect(isTransientS3Error(errnoError("ECONNREFUSED"))).toBe(false);
    expect(isTransientS3Error(errnoError("ENOTFOUND"))).toBe(true);
  });

  it("rejects real answers and client-side faults", () => {
    expect(isTransientS3Error(sdkError("NoSuchKey", 404))).toBe(false);
    expect(isTransientS3Error(sdkError("NoSuchBucket", 404))).toBe(false);
    expect(isTransientS3Error(sdkError("PreconditionFailed", 412))).toBe(false);
    expect(isTransientS3Error(sdkError("AccessDenied", 403))).toBe(false);
    expect(isTransientS3Error(new Error("something else"))).toBe(false);
    expect(isTransientS3Error(undefined)).toBe(false);
  });

  it("looks through a cause chain, which is how the SDK reports socket errors", () => {
    const wrapped = new Error("connection failure", { cause: errnoError("ECONNRESET") });
    expect(isTransientS3Error(wrapped)).toBe(true);
  });
});

describe("withS3Retry", () => {
  it("returns the first success without sleeping at all", async () => {
    const { sleep, delays } = fakeSleep();
    const op = vi.fn().mockResolvedValue("ok");

    await expect(withS3Retry(op, { sleep })).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("retries a transient failure and reports each attempt before waiting", async () => {
    const { sleep, delays } = fakeSleep();
    const notices: RetryNotice[] = [];
    let calls = 0;
    const op = async (): Promise<string> => {
      calls++;
      if (calls <= 2) throw errnoError("ECONNRESET");
      return "ok";
    };

    await expect(withS3Retry(op, { sleep, onRetry: (n) => notices.push(n) })).resolves.toBe("ok");

    expect(calls).toBe(3);
    expect(notices.map((n) => n.attempt)).toEqual([1, 2]);
    // The reported delay is the one actually waited -- a caller renders it
    // verbatim, so it must not be a pre-jitter figure.
    expect(notices.map((n) => n.delayMs)).toEqual(delays);
  });

  it("never gives up on a transient failure -- there is no attempt ceiling", async () => {
    const { sleep } = fakeSleep();
    let calls = 0;
    const op = async (): Promise<string> => {
      calls++;
      if (calls <= 500) throw errnoError("ETIMEDOUT");
      return "ok";
    };

    await expect(withS3Retry(op, { sleep })).resolves.toBe("ok");
    expect(calls).toBe(501);
  });

  it("caps the backoff instead of letting it grow, which is what bounds an unlimited retry", async () => {
    const { sleep, delays } = fakeSleep();
    let calls = 0;
    const op = async (): Promise<string> => {
      calls++;
      if (calls <= 40) throw errnoError("ECONNRESET");
      return "ok";
    };

    await withS3Retry(op, { sleep });

    // Jitter spans 50-100% of the capped delay, so the ceiling is 30_000 and
    // nothing may exceed it however many attempts have gone by.
    expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
    expect(delays.slice(-10).every((d) => d >= 15_000)).toBe(true);
  });

  it("throws a non-transient error on the first attempt, without retrying", async () => {
    const { sleep, delays } = fakeSleep();
    const op = vi.fn().mockRejectedValue(sdkError("NoSuchBucket", 404));

    await expect(withS3Retry(op, { sleep })).rejects.toThrow("NoSuchBucket");
    expect(op).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("measures elapsed time from the first failure, not from the call", async () => {
    const { sleep } = fakeSleep();
    const notices: RetryNotice[] = [];
    let calls = 0;
    const op = async (): Promise<string> => {
      calls++;
      if (calls <= 2) throw errnoError("ECONNRESET");
      return "ok";
    };

    await withS3Retry(op, { sleep, onRetry: (n) => notices.push(n) });

    // The first notice fires immediately after the first failure, so its
    // elapsed is ~0; later ones can only be >= it.
    expect(notices[0]!.elapsedMs).toBeLessThan(1000);
    expect(notices[1]!.elapsedMs).toBeGreaterThanOrEqual(notices[0]!.elapsedMs);
  });
});
