import { Readable } from "node:stream";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Crc64Nvme } from "@aws-sdk/checksums/crc";

const { uploadObjectStream, S3UploadFatalError } = await import("../../../src/s3/upload-object.js");
const { MULTIPART_THRESHOLD_BYTES, multipartPartSize } = await import("../../../src/s3/client.js");

async function crcOf(buf: Buffer): Promise<string> {
  const crc = new Crc64Nvme();
  crc.update(buf);
  return Buffer.from(await crc.digest()).toString("base64");
}

function makeStream(buf: Buffer): Readable {
  // Multiple chunks, not one -- a single-chunk source is already fully
  // buffered before any reader is touched, and would never exercise the
  // part-by-part reads these tests are about.
  const chunkSize = 64 * 1024;
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += chunkSize) chunks.push(buf.subarray(i, i + chunkSize));
  return Readable.from(chunks);
}

type Command = { constructor: { name: string }; input: Record<string, unknown> };

/** A fake S3 client dispatching by command name, same shape every test below configures differently. */
function fakeClient(
  handlers: Partial<Record<string, (input: Record<string, unknown>) => unknown>>,
) {
  const calls: Command[] = [];
  const send = vi.fn(async (command: Command) => {
    calls.push(command);
    const handler = handlers[command.constructor.name];
    if (!handler) throw new Error(`fakeClient: no handler for ${command.constructor.name}`);
    const result = handler(command.input);
    return result instanceof Promise ? result : Promise.resolve(result);
  });
  return { send, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs `promise` to completion while fast-forwarding through any `withS3Retry` backoff it waits on. */
async function settleWithRetries<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  void promise.finally(() => {
    settled = true;
  });
  while (!settled) {
    await vi.advanceTimersByTimeAsync(30_000);
  }
  return promise;
}

describe("uploadObjectStream: single PUT below the multipart threshold", () => {
  it("buffers the body and retries the whole (small) request on a transient failure", async () => {
    const buf = Buffer.from("x".repeat(1024));
    const expected = await crcOf(buf);
    let attempts = 0;
    const client = fakeClient({
      PutObjectCommand: () => {
        attempts++;
        if (attempts === 1) {
          const err = new Error("socket hang up") as NodeJS.ErrnoException;
          err.code = "ECONNRESET";
          throw err;
        }
        return { ChecksumCRC64NVME: expected };
      },
    });

    const result = await settleWithRetries(
      uploadObjectStream(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client as any,
        "bucket",
        "objects/small",
        makeStream(buf),
        buf.length,
      ),
    );

    expect(result).toBe(expected);
    expect(attempts).toBe(2);
  });

  it("surfaces a non-transient error directly, not as a generic 'aborted'", async () => {
    const buf = Buffer.from("payload");
    const client = fakeClient({
      PutObjectCommand: () => {
        const err = new Error("Access Denied") as Error & { name: string };
        err.name = "AccessDenied";
        throw err;
      },
    });

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      uploadObjectStream(client as any, "bucket", "objects/small", makeStream(buf), buf.length),
    ).rejects.toMatchObject({
      name: "AccessDenied",
      message: expect.stringContaining("Access Denied"),
    });
  });
});

describe("uploadObjectStream: multipart at or above the threshold", () => {
  const partSize = multipartPartSize(MULTIPART_THRESHOLD_BYTES);

  it("resends only the part that failed, not the whole file, and retries no more than that part", async () => {
    const buf = Buffer.alloc(MULTIPART_THRESHOLD_BYTES, 7);
    const expected = await crcOf(buf);
    const partAttempts = new Map<number, number>();
    const client = fakeClient({
      CreateMultipartUploadCommand: () => ({ UploadId: "upload-1" }),
      UploadPartCommand: (input) => {
        const partNumber = input.PartNumber as number;
        const n = (partAttempts.get(partNumber) ?? 0) + 1;
        partAttempts.set(partNumber, n);
        if (partNumber === 2 && n === 1) {
          const err = new Error("socket hang up") as NodeJS.ErrnoException;
          err.code = "ECONNRESET";
          throw err;
        }
        return { ETag: `etag-${partNumber}` };
      },
      CompleteMultipartUploadCommand: () => ({ ChecksumCRC64NVME: expected }),
    });

    const result = await settleWithRetries(
      uploadObjectStream(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client as any,
        "bucket",
        "objects/large",
        makeStream(buf),
        buf.length,
      ),
    );

    expect(result).toBe(expected);
    // Only part 2 (the one that failed) was sent twice; every other part exactly once.
    expect(partAttempts.get(2)).toBe(2);
    for (const [part, attempts] of partAttempts) {
      if (part !== 2) expect(attempts).toBe(1);
    }
  });

  it("never has more than 4 UploadPart requests in flight at once", async () => {
    // Real timers: this test's own `setTimeout(0)` polling is what waits
    // for the producer to catch up, not `withS3Retry`'s backoff -- no
    // failures happen here, so there's nothing for `settleWithRetries`'s
    // fake-timer fast-forward to do, and mixing the two just adds noise.
    vi.useRealTimers();
    const buf = Buffer.alloc(partSize * 10, 1);
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    const client = fakeClient({
      CreateMultipartUploadCommand: () => ({ UploadId: "upload-1" }),
      UploadPartCommand: (input) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const partNumber = input.PartNumber as number;
        return new Promise((resolve) => {
          releases.push(() => {
            inFlight--;
            resolve({ ETag: `etag-${partNumber}` });
          });
        });
      },
      CompleteMultipartUploadCommand: () => ({ ChecksumCRC64NVME: "irrelevant-for-this-test" }),
    });

    const done = uploadObjectStream(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      "bucket",
      "objects/wide",
      makeStream(buf),
      buf.length,
    );
    done.catch(() => undefined); // the checksum mismatch at the end is not what this test checks

    // Let every part that *can* start, start -- bounded by a real
    // deadline, not a fixed tick count, so this isn't sensitive to how
    // many microtask hops the producer/pool happen to take.
    const deadline = Date.now() + 2000;
    while (releases.length < 4 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(releases.length).toBe(4);
    expect(maxInFlight).toBeLessThanOrEqual(4);

    while (releases.length > 0) {
      releases.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    await done.catch(() => undefined);
  });

  it("aborts the multipart upload once a part fails irrecoverably, and surfaces that error", async () => {
    // Only part 1 fails; parts 2+ succeed normally, the way real in-flight
    // HTTP requests dispatched before the failure would -- `queue.onIdle()`
    // waits for every dispatched part to settle, so a test where every
    // part fails at once (or hangs forever) either races several
    // simultaneous rejections through the same error box or never settles
    // at all. One real failure among otherwise-successful parts is what
    // this path actually looks like.
    const buf = Buffer.alloc(MULTIPART_THRESHOLD_BYTES, 3);
    let abortedWith: string | undefined;
    const client = fakeClient({
      CreateMultipartUploadCommand: () => ({ UploadId: "upload-2" }),
      UploadPartCommand: (input) => {
        if (input.PartNumber === 1) {
          const err = new Error("Access Denied") as Error & { name: string };
          err.name = "AccessDenied";
          throw err;
        }
        return { ETag: `etag-${input.PartNumber}` };
      },
      AbortMultipartUploadCommand: (input) => {
        abortedWith = input.UploadId as string;
        return {};
      },
    });

    await expect(
      uploadObjectStream(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client as any,
        "bucket",
        "objects/large",
        makeStream(buf),
        buf.length,
      ),
    ).rejects.toMatchObject({ name: "AccessDenied" });
    expect(abortedWith).toBe("upload-2");
  });

  it("logs, but does not throw over the real error, when AbortMultipartUpload cleanup itself fails", async () => {
    // Real timers: the cleanup's own bounded retry (a plain `setTimeout`
    // loop, not `withS3Retry`) needs real wall-clock delays to resolve,
    // and advancing fake time through it alongside p-queue's own
    // concurrent-task settling produced a spurious "unhandled rejection"
    // -- the promise was in fact always awaited below, just not on a tick
    // Node's detector and the fake-timer clock agreed on.
    vi.useRealTimers();
    // Same shape as the test above: only part 1 fails, so there's exactly
    // one rejection for the error box to record and `queue.onIdle()` still
    // settles once the others succeed.
    const buf = Buffer.alloc(MULTIPART_THRESHOLD_BYTES, 3);
    const logger = { warn: vi.fn() };
    const client = fakeClient({
      CreateMultipartUploadCommand: () => ({ UploadId: "upload-3" }),
      UploadPartCommand: (input) => {
        if (input.PartNumber === 1) {
          const err = new Error("Access Denied") as Error & { name: string };
          err.name = "AccessDenied";
          throw err;
        }
        return { ETag: `etag-${input.PartNumber}` };
      },
      AbortMultipartUploadCommand: () => {
        throw new Error("abort also failed");
      },
    });

    const result = uploadObjectStream(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      "bucket",
      "objects/large",
      makeStream(buf),
      buf.length,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { logger: logger as any },
    );

    await expect(result).rejects.toMatchObject({ name: "AccessDenied" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: "upload-3" }),
      expect.stringContaining("AbortMultipartUpload cleanup failed"),
    );
  });

  it("stops promptly when the shared signal is aborted externally, mid-upload", async () => {
    const buf = Buffer.alloc(MULTIPART_THRESHOLD_BYTES * 3, 9);
    const controller = new AbortController();
    let partsStarted = 0;
    const client = fakeClient({
      CreateMultipartUploadCommand: () => ({ UploadId: "upload-4" }),
      UploadPartCommand: () => {
        partsStarted++;
        if (partsStarted === 2) controller.abort(new Error("mirror gave up"));
        return new Promise(() => {
          // never resolves on its own -- only the abort should end this
        });
      },
      AbortMultipartUploadCommand: () => ({}),
    });

    await expect(
      uploadObjectStream(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client as any,
        "bucket",
        "objects/large",
        makeStream(buf),
        buf.length,
        undefined,
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });
});

describe("S3UploadFatalError", () => {
  it("names the path(s) and the hash, and carries the real error as its cause", () => {
    const cause = new Error("Access Denied");
    const err = new S3UploadFatalError(["foo.txt"], "deadbeef", cause);
    expect(err.message).toContain("foo.txt");
    expect(err.message).toContain("Access Denied");
    expect(err.cause).toBe(cause);
    expect(err.hash).toBe("deadbeef");
  });
});
