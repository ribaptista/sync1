import { Readable } from "node:stream";
import { describe, it, expect } from "vitest";
import { UploadChecksumTap } from "../../../src/s3/checksum.js";

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("UploadChecksumTap", () => {
  it("computes the exact CRC64NVME a real S3-compatible server reports for a small single-PUT body", async () => {
    // "qVz5kPyaEcE=" is not made up: it's what a real LocalStack container
    // (4.3 through 4.9) actually returned for PutObject with
    // ChecksumAlgorithm: CRC64NVME on this exact buffer -- confirmed by
    // directly probing five separate container versions, see the version
    // note in test/e2e/helpers/localstack.ts. Cross-checking against a real
    // server's own answer, not just round-tripping this implementation
    // against itself, is the point: a self-consistent test can't catch a
    // wrong algorithm variant, wrong endianness, or wrong base64 framing.
    const tap = new UploadChecksumTap();
    const source = Readable.from([Buffer.from("hello crc64")]);
    const out = await drain(tap.tap(source));
    expect(out.toString()).toBe("hello crc64");
    expect(await tap.checksum()).toBe("qVz5kPyaEcE=");
  });

  it("computes the exact CRC64NVME a real S3-compatible server reports for a 12 MiB multipart body", async () => {
    // "ubtfHLpVJ6c=" the same way, via a real 3-part multipart Upload (5
    // MiB parts) against the same containers. This is the value that makes
    // CRC64NVME the right algorithm here: S3 reports this SAME full-object
    // checksum for this body whether it went up as one PUT or several
    // parts, unlike every other supported algorithm (see checksum.ts).
    const big = Buffer.alloc(12 * 1024 * 1024, 7);
    const tap = new UploadChecksumTap();
    // Fed as several chunks, not one write, since a real streamed body
    // never arrives as a single buffer -- exercises the update() call
    // crossing internal boundaries the same way a real upload would.
    const chunks = [
      big.subarray(0, 4 * 1024 * 1024),
      big.subarray(4 * 1024 * 1024, 9 * 1024 * 1024),
      big.subarray(9 * 1024 * 1024),
    ];
    const source = Readable.from(chunks);
    const out = await drain(tap.tap(source));
    expect(out.length).toBe(big.length);
    expect(await tap.checksum()).toBe("ubtfHLpVJ6c=");
  });

  it("propagates a source error to the tapped stream instead of stalling forever", async () => {
    const tap = new UploadChecksumTap();
    const source = new Readable({
      read() {
        this.destroy(new Error("boom"));
      },
    });
    await expect(drain(tap.tap(source))).rejects.toThrow("boom");
  });
});
