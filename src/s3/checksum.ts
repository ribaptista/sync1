import { Crc64Nvme } from "@aws-sdk/checksums/crc";
import { Transform, type Readable } from "node:stream";

/**
 * Computes the CRC64NVME checksum over an upload body as it streams past,
 * so an object can be verified against what S3 says it stored without
 * buffering it or reading it twice.
 *
 * CRC64NVME specifically -- not the SDK's silent default (CRC32), and not
 * SHA256 -- because it is the one algorithm S3 computes as a true
 * `FULL_OBJECT` checksum on *both* a single PUT and a multipart upload.
 * Every other supported algorithm answers a multipart upload with a
 * `COMPOSITE` instead: a hash of the concatenated per-part digests, which
 * depends on where the parts were split rather than only on the content,
 * and would silently mean something different if the part-size constant
 * ever changed. Confirmed directly against real containers, not from
 * documentation alone -- see the LocalStack version note in
 * `test/e2e/helpers/localstack.ts`.
 *
 * This is what lets `putObjectStream` treat a single PUT and a multipart
 * upload identically: one checksum, computed the same way, verified the
 * same way, regardless of upload path or part size.
 */
export class UploadChecksumTap {
  private readonly crc = new Crc64Nvme();

  /** Wraps `source`, passing every byte through untouched while hashing it. */
  tap(source: Readable): Readable {
    const transform = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        this.crc.update(chunk);
        callback(null, chunk);
      },
    });
    // Propagate a source failure rather than letting the pipeline stall: a
    // retried upload builds a whole new tap and stream anyway.
    source.on("error", (err) => transform.destroy(err));
    return source.pipe(transform);
  }

  /**
   * The full-object CRC64NVME checksum, base64 -- what S3 returns for both
   * a single PUT and a multipart upload, and what we store. Only valid
   * once the tapped stream has been fully consumed.
   */
  async checksum(): Promise<string> {
    const digest = await this.crc.digest();
    return Buffer.from(digest).toString("base64");
  }
}
