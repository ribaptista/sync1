import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { copyObjectStorageClass } = await import("../../../src/s3/copy-object.js");
const { COPY_MULTIPART_THRESHOLD_BYTES } = await import("../../../src/s3/client.js");

type Command = { constructor: { name: string }; input: Record<string, unknown> };

/** A fake S3 client dispatching by command name, same shape as upload-object.test.ts's own. */
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

const CHECKSUM = "expected-checksum==";

describe("copyObjectStorageClass: at or below the threshold", () => {
  it("sends a single CopyObject and nothing else", async () => {
    const client = fakeClient({
      CopyObjectCommand: (input) => {
        expect(input.CopySource).toBe("bucket/objects/small");
        expect(input.StorageClass).toBe("GLACIER");
        return {};
      },
    });

    await copyObjectStorageClass(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      "bucket",
      "objects/small",
      "GLACIER",
      1024,
      CHECKSUM,
    );

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.constructor.name).toBe("CopyObjectCommand");
  });

  it("treats exactly the threshold as a single CopyObject, not multipart", async () => {
    const client = fakeClient({
      CopyObjectCommand: () => ({}),
    });

    await copyObjectStorageClass(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      "bucket",
      "objects/exact",
      "GLACIER",
      COPY_MULTIPART_THRESHOLD_BYTES,
      CHECKSUM,
    );

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.constructor.name).toBe("CopyObjectCommand");
  });
});

describe("copyObjectStorageClass: multipart above the threshold", () => {
  // A small override so these tests don't actually move gigabytes of
  // fake data -- `thresholdBytes`/`partSizeBytes` are test-only overrides
  // for exactly this reason (see CopyObjectStorageClassOptions).
  const THRESHOLD = 10;
  const PART_SIZE = 10;

  it("covers the object exactly in ranges, ending with a shorter last part", async () => {
    const sizeBytes = 25; // 3 parts of 10 at PART_SIZE: [0-9],[10-19],[20-24]
    const ranges: { PartNumber: number; CopySourceRange: string }[] = [];
    const client = fakeClient({
      CreateMultipartUploadCommand: (input) => {
        expect(input.ChecksumAlgorithm).toBe("CRC64NVME");
        expect(input.ChecksumType).toBe("FULL_OBJECT");
        expect(input.StorageClass).toBe("DEEP_ARCHIVE");
        return { UploadId: "upload-1" };
      },
      UploadPartCopyCommand: (input) => {
        ranges.push({
          PartNumber: input.PartNumber as number,
          CopySourceRange: input.CopySourceRange as string,
        });
        return { CopyPartResult: { ETag: `etag-${input.PartNumber}` } };
      },
      CompleteMultipartUploadCommand: (input) => {
        const parts = input.MultipartUpload as { Parts: { PartNumber: number }[] };
        expect(parts.Parts.map((p) => p.PartNumber)).toEqual([1, 2, 3]);
        expect(input.ChecksumCRC64NVME).toBe(CHECKSUM);
        expect(input.ChecksumType).toBe("FULL_OBJECT");
        return { ChecksumCRC64NVME: CHECKSUM };
      },
    });

    await copyObjectStorageClass(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      "bucket",
      "objects/large",
      "DEEP_ARCHIVE",
      sizeBytes,
      CHECKSUM,
      { thresholdBytes: THRESHOLD, partSizeBytes: PART_SIZE },
    );

    ranges.sort((a, b) => a.PartNumber - b.PartNumber);
    expect(ranges).toEqual([
      { PartNumber: 1, CopySourceRange: "bytes=0-9" },
      { PartNumber: 2, CopySourceRange: "bytes=10-19" },
      { PartNumber: 3, CopySourceRange: "bytes=20-24" },
    ]);
  });

  it("raises the part size when the production default would exceed the 10,000-part cap", async () => {
    // Accessed through the module's own behavior, not by reaching into its
    // internals: a size whose default 512 MiB part size would need more
    // than 10,000 parts forces a larger part size instead. 10,000 * 512MiB
    // = ~5.24 TB; one byte over that must still resolve to exactly one
    // part size covering it within 10,000 parts.
    const sizeBytes = 10_000 * 512 * 1024 * 1024 + 1;
    let partCount = 0;
    const client = fakeClient({
      CreateMultipartUploadCommand: () => ({ UploadId: "upload-cap" }),
      UploadPartCopyCommand: (input) => {
        partCount++;
        return { CopyPartResult: { ETag: `etag-${input.PartNumber}` } };
      },
      CompleteMultipartUploadCommand: () => ({ ChecksumCRC64NVME: CHECKSUM }),
    });

    await copyObjectStorageClass(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      "bucket",
      "objects/huge",
      "GLACIER",
      sizeBytes,
      CHECKSUM,
      { thresholdBytes: THRESHOLD },
    );

    expect(partCount).toBeLessThanOrEqual(10_000);
  });

  it("resends only the part that failed, not the whole copy", async () => {
    const sizeBytes = 30; // 3 parts
    const partAttempts = new Map<number, number>();
    const client = fakeClient({
      CreateMultipartUploadCommand: () => ({ UploadId: "upload-2" }),
      UploadPartCopyCommand: (input) => {
        const partNumber = input.PartNumber as number;
        const n = (partAttempts.get(partNumber) ?? 0) + 1;
        partAttempts.set(partNumber, n);
        if (partNumber === 2 && n === 1) {
          const err = new Error("socket hang up") as NodeJS.ErrnoException;
          err.code = "ECONNRESET";
          throw err;
        }
        return { CopyPartResult: { ETag: `etag-${partNumber}` } };
      },
      CompleteMultipartUploadCommand: () => ({ ChecksumCRC64NVME: CHECKSUM }),
    });

    await settleWithRetries(
      copyObjectStorageClass(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client as any,
        "bucket",
        "objects/retry",
        "GLACIER",
        sizeBytes,
        CHECKSUM,
        { thresholdBytes: THRESHOLD, partSizeBytes: PART_SIZE },
      ),
    );

    expect(partAttempts.get(2)).toBe(2);
    for (const [part, attempts] of partAttempts) {
      if (part !== 2) expect(attempts).toBe(1);
    }
  });

  it("aborts the multipart upload and rethrows on a non-transient part failure", async () => {
    const sizeBytes = 30;
    let abortedWith: string | undefined;
    const client = fakeClient({
      CreateMultipartUploadCommand: () => ({ UploadId: "upload-3" }),
      UploadPartCopyCommand: (input) => {
        if (input.PartNumber === 1) {
          const err = new Error("Access Denied") as Error & { name: string };
          err.name = "AccessDenied";
          throw err;
        }
        return { CopyPartResult: { ETag: `etag-${input.PartNumber}` } };
      },
      AbortMultipartUploadCommand: (input) => {
        abortedWith = input.UploadId as string;
        return {};
      },
    });

    await expect(
      copyObjectStorageClass(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client as any,
        "bucket",
        "objects/fatal",
        "GLACIER",
        sizeBytes,
        CHECKSUM,
        { thresholdBytes: THRESHOLD, partSizeBytes: PART_SIZE },
      ),
    ).rejects.toMatchObject({ name: "AccessDenied" });
    expect(abortedWith).toBe("upload-3");
  });

  it("aborts and throws CorruptionError when the completed object's checksum doesn't match", async () => {
    const sizeBytes = 20;
    let abortedWith: string | undefined;
    const client = fakeClient({
      CreateMultipartUploadCommand: () => ({ UploadId: "upload-4" }),
      UploadPartCopyCommand: (input) => ({ CopyPartResult: { ETag: `etag-${input.PartNumber}` } }),
      CompleteMultipartUploadCommand: () => ({ ChecksumCRC64NVME: "wrong-checksum==" }),
      AbortMultipartUploadCommand: (input) => {
        abortedWith = input.UploadId as string;
        return {};
      },
    });

    await expect(
      copyObjectStorageClass(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client as any,
        "bucket",
        "objects/corrupt",
        "GLACIER",
        sizeBytes,
        CHECKSUM,
        { thresholdBytes: THRESHOLD, partSizeBytes: PART_SIZE },
      ),
    ).rejects.toMatchObject({ name: "CorruptionError" });
    // The completion itself already succeeded by the time the checksum is
    // checked -- there is no longer an in-progress multipart upload to
    // abort, so this must NOT have attempted one.
    expect(abortedWith).toBeUndefined();
  });
});
