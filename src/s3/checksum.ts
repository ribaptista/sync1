import { Crc64Nvme } from "@aws-sdk/checksums/crc";
import { Transform, pipeline, type Readable } from "node:stream";

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
    // `pipeline`, not `source.pipe(transform)`, because failure has to
    // travel in BOTH directions. Forward (a source failure reaching the
    // consumer) was all `.pipe()` plus an error listener ever gave us.
    // Backward is the one that hung a real 30-hour sync: when lib-storage
    // abandons the body after a part upload fails, it destroys this
    // transform -- and `.pipe()` answers that by merely *unpiping* the
    // source, leaving it paused with a full buffer, neither ended nor
    // errored. When the source is a `teeStream` branch, that stalls the
    // shared source and with it the mirror branch, forever and silently.
    // `pipeline` destroys the source with ERR_STREAM_PREMATURE_CLOSE
    // instead, which the tee turns into a failure of both branches. The
    // no-op callback is required by `pipeline`'s signature; the error
    // itself reaches whoever is consuming `transform`. A retried upload
    // builds a whole new tap and stream anyway.
    pipeline(source, transform, () => {});
    return transform;
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
