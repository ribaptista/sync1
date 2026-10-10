import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";

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

  /**
   * `@smithy`'s own request/response logging middleware
   * (`loggerMiddleware.js`) calls `logger.info({ clientName, commandName,
   * input, output, metadata })` directly -- no message string, just that one
   * record -- which is exactly what used to turn into the unreadable
   * `"msg":"[object Object]"` a real sync run produced: `String(record)`
   * discards everything in it. `input.Body` there is the actual ciphertext
   * being uploaded (this project passes it as a whole-object/whole-part
   * `Buffer`), so it must never reach the log verbatim either.
   */
  describe("the SDK's own request/response logging middleware (an object, not a message string)", () => {
    function installFakeLogger(): {
      calls: Array<[Record<string, unknown>, string]>;
      invoke: (record: unknown) => void;
    } {
      const calls: Array<[Record<string, unknown>, string]> = [];
      const logger = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: (context: Record<string, unknown>, message: string) => calls.push([context, message]),
        warn: vi.fn(),
        error: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      const client = createS3Client({ region: "us-east-1", endpoint: undefined, logger });
      return {
        calls,
        // `client.config.logger` is `smithyLoggerAdapter(logger)`, the thing
        // actually under test here -- invoking the fake `logger` directly
        // would skip it entirely, same reasoning as the two tests above.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        invoke: (record: unknown) => (client.config.logger as any).info(record),
      };
    }

    it("drops a Buffer Body, keeping the rest of the record and a readable message", () => {
      const { calls, invoke } = installFakeLogger();
      invoke({
        clientName: "S3Client",
        commandName: "PutObjectCommand",
        input: { Bucket: "my-bucket", Key: "objects/aa", Body: Buffer.alloc(1024 * 1024, 1) },
        output: {},
        metadata: { httpStatusCode: 200, requestId: "req-1" },
      });

      expect(calls).toHaveLength(1);
      const [context, message] = calls[0]!;
      expect(message).toBe("s3 PutObjectCommand");
      expect(context.source).toBe("aws-sdk");
      expect(context.sdk).toEqual({
        clientName: "S3Client",
        commandName: "PutObjectCommand",
        input: { Bucket: "my-bucket", Key: "objects/aa" },
        output: {},
        metadata: { httpStatusCode: 200, requestId: "req-1" },
      });
      expect(JSON.stringify(context)).not.toContain("[object Object]");
    });

    it("drops a stream Body the same way", () => {
      const { calls, invoke } = installFakeLogger();
      invoke({
        commandName: "UploadPartCommand",
        input: { Bucket: "my-bucket", Key: "objects/aa", PartNumber: 3, Body: Readable.from([]) },
        metadata: { httpStatusCode: 200 },
      });

      const sdk = calls[0]![0].sdk as { input: Record<string, unknown> };
      expect(sdk.input).toEqual({ Bucket: "my-bucket", Key: "objects/aa", PartNumber: 3 });
    });

    it("reports a failed command with the error's name and message, and a '... failed' message", () => {
      const { calls, invoke } = installFakeLogger();
      invoke({
        commandName: "PutObjectCommand",
        input: { Bucket: "my-bucket", Key: "objects/aa" },
        error: Object.assign(new Error("Access Denied"), { name: "AccessDenied" }),
      });

      const [context, message] = calls[0]!;
      expect(message).toBe("s3 PutObjectCommand failed");
      expect((context.sdk as { error: unknown }).error).toEqual({
        name: "AccessDenied",
        message: "Access Denied",
      });
    });

    it("falls back to a generic command name, and never throws, for an unrecognized or cyclic record", () => {
      const { calls, invoke } = installFakeLogger();
      const cyclic: Record<string, unknown> = { input: { Bucket: "my-bucket" } };
      cyclic.self = cyclic;

      expect(() => invoke(cyclic)).not.toThrow();
      expect(calls[0]![1]).toBe("s3 command");
    });

    /**
     * A real sync run crashed on exactly this: an SDK record with an
     * `undefined`-valued field (an absent `output` on some responses is one
     * routine source) reaches `Object.getPrototypeOf(value)`, which throws
     * "Cannot convert undefined or null to object" for `undefined`
     * specifically -- `null` alone isn't enough to catch it.
     */
    it("drops an undefined field instead of throwing", () => {
      const { calls, invoke } = installFakeLogger();

      expect(() =>
        invoke({
          commandName: "PutObjectCommand",
          input: { Bucket: "my-bucket", Key: "objects/aa" },
          output: undefined,
          metadata: { httpStatusCode: 200, cfId: undefined },
        }),
      ).not.toThrow();

      const sdk = calls[0]![0].sdk as Record<string, unknown>;
      expect("output" in sdk).toBe(false);
      expect(sdk.metadata).toEqual({ httpStatusCode: 200 });
    });
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
