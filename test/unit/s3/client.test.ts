import { describe, it, expect, vi } from "vitest";

const { multipartPartSize, MULTIPART_THRESHOLD_BYTES, headObject, createS3Client } =
  await import("../../../src/s3/client.js");

describe("createS3Client: routing the SDK's own diagnostics", () => {
  /**
   * Smithy's retry middleware falls back to `console.warn` specifically
   * when nothing was configured here (it checks `instanceof NoOpLogger`)
   * -- which is how "An error was encountered in a non-retryable
   * streaming request" ended up on a user's terminal, with no path, no
   * attempt count, and nothing a later `grep` over `sync.log` could find.
   * `smithyLoggerAdapter` isn't exported, so this drives it the only way
   * observable from outside: build a client with a logger, then exercise
   * the adapter actually installed as `client.config.logger`.
   */
  it("gives the client a non-default logger when one is passed, structured per this repo's convention", () => {
    const calls: Array<[Record<string, unknown>, string]> = [];
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: (context: Record<string, unknown>, message: string) => calls.push([context, message]),
      error: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const client = createS3Client({ region: "us-east-1", endpoint: undefined, logger });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client.config.logger as any).warn(
      "An error was encountered in a non-retryable streaming request.",
    );
    expect(calls).toEqual([
      [{ source: "aws-sdk" }, "An error was encountered in a non-retryable streaming request."],
    ]);
  });

  it("folds extra arguments into a structured 'args' field, never into the message string", () => {
    const calls: Array<[Record<string, unknown>, string]> = [];
    const logger = {
      trace: vi.fn(),
      debug: (context: Record<string, unknown>, message: string) => calls.push([context, message]),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const client = createS3Client({ region: "us-east-1", endpoint: undefined, logger });
    const extra = { attempt: 2 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client.config.logger as any).debug("retrying", extra);

    expect(calls).toEqual([[{ source: "aws-sdk", args: [extra] }, "retrying"]]);
  });
});

describe("multipart part size", () => {
  const MiB = 1024 * 1024;

  it("stays at S3's 5 MiB minimum while that fits in 10,000 parts", () => {
    expect(multipartPartSize(MULTIPART_THRESHOLD_BYTES)).toBe(5 * MiB);
    expect(multipartPartSize(10_000 * 5 * MiB)).toBe(5 * MiB);
  });

  it("grows past ~52.4 GB so an object never needs more than 10,000 parts", () => {
    // The real file that hit the old lib-storage default: 5 MiB parts run
    // out at 52,428,800,000 bytes, ~44 GB short of this one.
    const size = 96_473_262_080;
    const partSize = multipartPartSize(size);
    expect(partSize).toBeGreaterThan(5 * MiB);
    expect(Math.ceil(size / partSize)).toBeLessThanOrEqual(10_000);
  });
});

describe("headObject", () => {
  /**
   * S3 omits `ChecksumCRC64NVME` from a HeadObject response entirely unless
   * the request asks for it, even when the object genuinely has one stored.
   * That omission is what let the aborted-run recovery path in
   * apply-local-changes.ts record a NULL `ciphertext_checksum` for an object
   * S3 could have described -- permanently, since every later run takes the
   * `objectsRepo.has(hash)` shortcut and never re-upserts that row.
   */
  it("asks for the checksum, and surfaces it when S3 reports one", async () => {
    const send = vi.fn(async (_command: unknown) => ({
      ETag: '"head-etag"',
      ChecksumCRC64NVME: "Zm9vYmFyMDA=",
    }));

    const head = await headObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { send } as any,
      "bucket",
      "objects/present",
    );

    const command = send.mock.calls[0]![0] as { input: { ChecksumMode?: string } };
    expect(command.input.ChecksumMode).toBe("ENABLED");
    expect(head?.checksumCrc64Nvme).toBe("Zm9vYmFyMDA=");
  });

  it("leaves the checksum absent when S3 reports none, rather than inventing one", async () => {
    // An object predating this vault asking for checksums at all has none
    // for S3 to report -- absent must stay absent, so it lands as a NULL
    // meaning "unknown", never a wrong value.
    const send = vi.fn(async (_command: unknown) => ({ ETag: '"head-etag"' }));

    const head = await headObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { send } as any,
      "bucket",
      "objects/legacy",
    );

    expect(head?.etag).toBe('"head-etag"');
    expect(head?.checksumCrc64Nvme).toBeUndefined();
  });
});
