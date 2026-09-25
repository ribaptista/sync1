import { Readable } from "node:stream";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PutObjectCommand } from "@aws-sdk/client-s3";

const doneMock = vi.fn(async (): Promise<{ ETag?: string; ChecksumCRC64NVME?: string }> => ({
  ETag: '"complete-etag"',
}));
const uploadCtor = vi.fn();

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: vi.fn().mockImplementation((...args: unknown[]) => {
    uploadCtor(...args);
    return { done: doneMock };
  }),
}));

const { putObjectStream, headObject, MULTIPART_THRESHOLD_BYTES } =
  await import("../../../src/s3/client.js");

function makeStream(content: string): Readable {
  return Readable.from([Buffer.from(content)]);
}

function fakeClient() {
  return { send: vi.fn(async (_command: unknown) => ({ ETag: '"put-etag"' })) };
}

beforeEach(() => {
  uploadCtor.mockClear();
  doneMock.mockClear();
});

describe("putObjectStream", () => {
  it("uses a plain PutObjectCommand below the multipart threshold, never constructing Upload", async () => {
    const client = fakeClient();
    await putObjectStream(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      "bucket",
      "objects/small",
      makeStream("hello"),
      MULTIPART_THRESHOLD_BYTES - 1,
    );

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0]![0]).toBeInstanceOf(PutObjectCommand);
    expect(uploadCtor).not.toHaveBeenCalled();
  });

  it("delegates to lib-storage's Upload at or above the threshold, never using a plain PutObjectCommand", async () => {
    const client = fakeClient();
    await putObjectStream(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      "bucket",
      "objects/large",
      makeStream("not actually large, but contentLength says so"),
      MULTIPART_THRESHOLD_BYTES,
    );

    expect(client.send).not.toHaveBeenCalled();
    expect(uploadCtor).toHaveBeenCalledTimes(1);
    const [{ client: passedClient, params }] = uploadCtor.mock.calls[0] as [
      { client: unknown; params: { Bucket: string; Key: string } },
    ];
    expect(passedClient).toBe(client);
    expect(params).toMatchObject({ Bucket: "bucket", Key: "objects/large" });
    expect(doneMock).toHaveBeenCalledTimes(1);
  });

  it("requests ChecksumAlgorithm: CRC64NVME on both the single-PUT and multipart paths", async () => {
    const client = fakeClient();

    await putObjectStream(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      "bucket",
      "objects/small",
      makeStream("hi"),
      MULTIPART_THRESHOLD_BYTES - 1,
    );
    const putCommand = client.send.mock.calls[0]![0] as { input: { ChecksumAlgorithm?: string } };
    expect(putCommand.input.ChecksumAlgorithm).toBe("CRC64NVME");

    await putObjectStream(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      "bucket",
      "objects/large",
      makeStream("hi"),
      MULTIPART_THRESHOLD_BYTES,
    );
    const [{ params }] = uploadCtor.mock.calls[uploadCtor.mock.calls.length - 1] as [
      { params: { ChecksumAlgorithm?: string } },
    ];
    expect(params.ChecksumAlgorithm).toBe("CRC64NVME");
  });
});

/**
 * The two tests above only check *wiring* -- that a PutObjectCommand or
 * Upload gets constructed with the right args. Neither mock ever drains
 * the tapped body or returns a Checksum* field, so verifyStoredChecksum's
 * comparison silently no-ops (an S3-compatible backend that doesn't
 * implement checksums is explicitly not a failure -- see client.ts). These
 * tests drain the body themselves, the way a real client actually would,
 * so the comparison logic genuinely runs.
 */
describe("putObjectStream: checksum verification", () => {
  // Same known-correct value checksum.test.ts cross-checks against a real
  // LocalStack container's own response for this exact buffer -- reused
  // here as "what a real, correctly-behaving S3 would report back".
  const CONTENT = "hello crc64";
  const REAL_CHECKSUM = "qVz5kPyaEcE=";

  async function drainingClient(reportedChecksum: string | undefined) {
    return {
      send: vi.fn(async (command: { input: { Body: AsyncIterable<unknown> } }) => {
        for await (const _chunk of command.input.Body) {
          // draining is the point -- a real client reads the whole body
        }
        return reportedChecksum === undefined ? {} : { ChecksumCRC64NVME: reportedChecksum };
      }),
    };
  }

  it("returns the checksum, unthrown, when S3's reported value matches what we computed", async () => {
    const client = await drainingClient(REAL_CHECKSUM);
    const result = await putObjectStream(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      "bucket",
      "objects/small",
      makeStream(CONTENT),
      MULTIPART_THRESHOLD_BYTES - 1,
    );
    expect(result).toBe(REAL_CHECKSUM);
  });

  it("throws CorruptionError, naming both values, when S3's reported checksum disagrees", async () => {
    const client = await drainingClient("wrong-checksum-entirely");
    await expect(
      putObjectStream(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client as any,
        "bucket",
        "objects/small",
        makeStream(CONTENT),
        MULTIPART_THRESHOLD_BYTES - 1,
      ),
    ).rejects.toThrow(
      `S3 stored "objects/small" with a CRC64NVME checksum of wrong-checksum-entirely, but the bytes we sent checksum to ${REAL_CHECKSUM} -- the upload was corrupted in transit or at rest`,
    );
  });

  it("does not throw when S3 reports no checksum at all -- an unsupported backend, not a mismatch", async () => {
    const client = await drainingClient(undefined);
    const result = await putObjectStream(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      "bucket",
      "objects/small",
      makeStream(CONTENT),
      MULTIPART_THRESHOLD_BYTES - 1,
    );
    // Still returns our own computed value -- it's stored regardless of
    // whether this particular backend could confirm it.
    expect(result).toBe(REAL_CHECKSUM);
  });

  it("verifies multipart the same way, draining Body via the mocked Upload before resolving", async () => {
    doneMock.mockImplementationOnce(async () => {
      const lastCall = uploadCtor.mock.calls[uploadCtor.mock.calls.length - 1] as [
        { params: { Body: AsyncIterable<unknown> } },
      ];
      for await (const _chunk of lastCall[0].params.Body) {
        // draining is the point
      }
      return { ChecksumCRC64NVME: REAL_CHECKSUM };
    });

    const result = await putObjectStream(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeClient() as any,
      "bucket",
      "objects/large",
      makeStream(CONTENT),
      MULTIPART_THRESHOLD_BYTES,
    );
    expect(result).toBe(REAL_CHECKSUM);
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
