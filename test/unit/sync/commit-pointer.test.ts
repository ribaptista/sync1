import { describe, it, expect, vi, beforeEach } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";

vi.mock("../../../src/s3/client.js", async (importOriginal) => {
  // CasConflictError is a real class the code under test does `instanceof`
  // against, so it has to be the genuine one, not a stub.
  const actual = await importOriginal<typeof import("../../../src/s3/client.js")>();
  return {
    CasConflictError: actual.CasConflictError,
    getObject: vi.fn(),
    putObjectCas: vi.fn(),
  };
});

const { commitCurrentPointer } = await import("../../../src/sync/commit-pointer.js");
const { getObject, putObjectCas, CasConflictError } = await import("../../../src/s3/client.js");
const getObjectMock = vi.mocked(getObject);
const putObjectCasMock = vi.mocked(putObjectCas);

const silentLogger = {
  debug: () => {},
  warn: () => {},
} as unknown as import("../../../src/logger.js").Logger;

const s3 = { client: {} as S3Client, bucket: "vault" };
const STAMP = "20260920T041500000Z-a1b2c3d4";

function pointerHolding(stamp: string): { body: Buffer; etag: string } {
  return { body: Buffer.from(stamp, "utf8"), etag: `"etag-${stamp}"` };
}

function transientError(): Error {
  return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
}

/** Skips the real backoff; every retry test here would otherwise wait it out. */
const noSleep = { sleep: (): Promise<void> => Promise.resolve() };

beforeEach(() => {
  getObjectMock.mockReset();
  putObjectCasMock.mockReset();
});

describe("commitCurrentPointer", () => {
  it("commits on the first attempt without reading the pointer back", async () => {
    putObjectCasMock.mockResolvedValue({ etag: '"new"' });

    await commitCurrentPointer(s3, "current", STAMP, '"old"', silentLogger, noSleep);

    expect(putObjectCasMock).toHaveBeenCalledTimes(1);
    // The read-back is a failure path only -- a clean commit pays nothing.
    expect(getObjectMock).not.toHaveBeenCalled();
  });

  it("retries a transient failure and commits on the next attempt", async () => {
    putObjectCasMock
      .mockRejectedValueOnce(transientError())
      .mockResolvedValueOnce({ etag: '"new"' });
    // The pointer still holds the old stamp -- our PUT genuinely didn't land.
    getObjectMock.mockResolvedValue(pointerHolding("some-older-stamp"));

    await expect(
      commitCurrentPointer(s3, "current", STAMP, '"old"', silentLogger, noSleep),
    ).resolves.toBeUndefined();

    expect(putObjectCasMock).toHaveBeenCalledTimes(2);
  });

  it("treats a lost response as the commit it was: the pointer already holds our stamp", async () => {
    // The whole point of this module. S3 applied the PUT, the response never
    // made it back, and a blind retry would have hit 412 against our own new
    // ETag and reported someone else's conflict.
    putObjectCasMock.mockRejectedValue(transientError());
    getObjectMock.mockResolvedValue(pointerHolding(STAMP));

    await expect(
      commitCurrentPointer(s3, "current", STAMP, '"old"', silentLogger, noSleep),
    ).resolves.toBeUndefined();

    // One attempt, one read-back, and no second PUT -- it never retried,
    // because there was nothing left to do.
    expect(putObjectCasMock).toHaveBeenCalledTimes(1);
    expect(getObjectMock).toHaveBeenCalledTimes(1);
  });

  it("still reports a genuine conflict when another machine moved the pointer", async () => {
    putObjectCasMock.mockRejectedValue(new CasConflictError("current"));
    getObjectMock.mockResolvedValue(pointerHolding("someone-elses-stamp"));

    await expect(
      commitCurrentPointer(s3, "current", STAMP, '"old"', silentLogger, noSleep),
    ).rejects.toThrow(CasConflictError);
    // A CAS conflict is not transient, so it is never retried.
    expect(putObjectCasMock).toHaveBeenCalledTimes(1);
  });

  it("recognises our own commit behind a conflict raised on a retry", async () => {
    // The sequence this exists for: attempt 1's response is lost, attempt 2
    // sends a now-stale If-Match and S3 answers 412. Without the read-back
    // that 412 would surface as RemoteDivergedError for a commit that
    // actually succeeded.
    putObjectCasMock
      .mockRejectedValueOnce(transientError())
      .mockRejectedValueOnce(new CasConflictError("current"));
    getObjectMock
      .mockResolvedValueOnce(pointerHolding("some-older-stamp")) // after attempt 1: not ours yet
      .mockResolvedValueOnce(pointerHolding(STAMP)); // after attempt 2: it is ours

    await expect(
      commitCurrentPointer(s3, "current", STAMP, '"old"', silentLogger, noSleep),
    ).resolves.toBeUndefined();

    expect(putObjectCasMock).toHaveBeenCalledTimes(2);
  });

  it("reports each retry to the caller so an unlimited wait stays visible", async () => {
    const notices: { attempt: number }[] = [];
    putObjectCasMock
      .mockRejectedValueOnce(transientError())
      .mockRejectedValueOnce(transientError())
      .mockResolvedValueOnce({ etag: '"new"' });
    getObjectMock.mockResolvedValue(pointerHolding("some-older-stamp"));

    await commitCurrentPointer(s3, "current", STAMP, '"old"', silentLogger, {
      ...noSleep,
      onRetry: (n) => notices.push({ attempt: n.attempt }),
    });

    expect(notices).toEqual([{ attempt: 1 }, { attempt: 2 }]);
  });

  it("retries the whole attempt when the read-back itself fails transiently", async () => {
    putObjectCasMock.mockRejectedValueOnce(transientError()).mockResolvedValueOnce({
      etag: '"new"',
    });
    getObjectMock.mockRejectedValueOnce(transientError());

    await expect(
      commitCurrentPointer(s3, "current", STAMP, '"old"', silentLogger, noSleep),
    ).resolves.toBeUndefined();

    expect(putObjectCasMock).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-transient failure that isn't ours", async () => {
    putObjectCasMock.mockRejectedValue(
      Object.assign(new Error("AccessDenied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      }),
    );
    getObjectMock.mockResolvedValue(pointerHolding("some-older-stamp"));

    await expect(
      commitCurrentPointer(s3, "current", STAMP, '"old"', silentLogger, noSleep),
    ).rejects.toThrow("AccessDenied");
    expect(putObjectCasMock).toHaveBeenCalledTimes(1);
  });
});
