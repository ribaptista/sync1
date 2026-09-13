import { Readable } from "node:stream";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PutObjectCommand } from "@aws-sdk/client-s3";

const doneMock = vi.fn(async () => ({ ETag: '"complete-etag"' }));
const uploadCtor = vi.fn();

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: vi.fn().mockImplementation((...args: unknown[]) => {
    uploadCtor(...args);
    return { done: doneMock };
  }),
}));

const { putObjectStream, MULTIPART_THRESHOLD_BYTES } = await import("../../../src/s3/client.js");

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
});
