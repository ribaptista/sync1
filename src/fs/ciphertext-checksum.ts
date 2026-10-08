import fs from "node:fs";
import { Crc64Nvme } from "@aws-sdk/checksums/crc";
import { encryptStream } from "../crypto/streaming-codec.js";
import { countingReadable } from "./counting-stream.js";

export type LocalCiphertextChecksumResult = { checksum: string } | { error: string };

/**
 * Re-encrypts a local plaintext file exactly as an upload would and returns
 * the CRC64NVME checksum (base64) of the resulting ciphertext -- the same
 * value S3 reports for the stored object, and what `objects.
 * ciphertext_checksum` records. Possible only because content encryption is
 * convergent: the object key and every chunk's nonce derive from the master
 * key plus the plaintext's own content hash, so identical plaintext always
 * encrypts to identical bytes (docs/architecture/vault-and-encryption.md).
 *
 * Nothing is written anywhere; the ciphertext is checksummed and discarded
 * chunk by chunk. `expectedHash` is passed to the codec so a file edited
 * since it was hashed fails here rather than producing a checksum for
 * different content -- that, a size change mid-read, or a read error comes
 * back as `{ error }` rather than throwing, since it describes this one
 * file, not a reason to abort the whole check.
 */
export async function localCiphertextChecksum(
  absolutePath: string,
  hash: string,
  size: number,
  masterKey: Buffer,
  onBytes: (n: number) => void = () => {},
): Promise<LocalCiphertextChecksumResult> {
  const source = fs.createReadStream(absolutePath);
  try {
    const encrypted = encryptStream(
      countingReadable(source, onBytes),
      size,
      masterKey,
      Buffer.from(hash, "hex"),
      { expectedHash: hash },
    );
    const crc = new Crc64Nvme();
    for await (const chunk of encrypted) crc.update(chunk as Buffer);
    return { checksum: Buffer.from(await crc.digest()).toString("base64") };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    // A codec failure throws out of its generator without touching the
    // file stream, so release the handle here rather than leaving it to GC.
    source.destroy();
  }
}
