import fs from "node:fs";
import type { Readable } from "node:stream";
import { encryptStream, type EncryptStreamOptions } from "../crypto/streaming-codec.js";
import { countingReadable } from "./counting-stream.js";
import { UploadChecksumTap } from "../s3/checksum.js";

export interface EncryptFileOptions {
  /** Plaintext byte progress, reported as the source is read -- not the (larger) ciphertext. */
  onBytes?: (n: number) => void;
  /** Forwarded to `encryptStream`: aborts the read if the caller gives up mid-file. */
  signal?: AbortSignal;
  /**
   * `"abort"` (sync's upload, mirror's catchup re-encrypt): a plaintext
   * hash mismatch aborts the stream before its final chunk, via
   * `encryptStream`'s own `expectedHash` -- the object must never be
   * created from the wrong content. `result.plaintextHash` is then always
   * `hash` itself, since the stream only ever completes once the two
   * already agree.
   *
   * `"report"` (sanity_check): never aborts on a mismatch. The point there
   * is to learn the *actual* hash of whatever is on disk right now and let
   * the caller decide what that means, not to guard a write.
   */
  hashMismatch: "abort" | "report";
  /**
   * Also checksum the ciphertext (CRC64NVME, base64 -- `src/s3/
   * checksum.ts`), the same value S3 reports for a stored object. `false`
   * for sync's own upload, which gets that checksum from S3's PUT/
   * multipart-complete response instead and would otherwise pay for a
   * second, pointless CRC pass over every byte it sends.
   */
  checksum: boolean;
}

export interface EncryptFileResult {
  /** BLAKE2b hex of the plaintext actually read -- not necessarily `hash`, in `"report"` mode. */
  plaintextHash: string;
  /** CRC64NVME, base64, or null when `checksum` was false. */
  ciphertextChecksum: string | null;
}

export interface EncryptedFile {
  /** The encoded object stream. Caller must fully drain (or destroy) it for `result` to ever settle. */
  ciphertext: Readable;
  /** Resolves once `ciphertext` has ended; rejects with whatever error ended it instead. */
  result: Promise<EncryptFileResult>;
}

/**
 * The one "read a local file, encrypt it exactly as an upload would, learn
 * what came out" pipeline -- shared by sync's upload (`runUploadJob` in
 * `src/sync/apply-local-changes.ts`), mirror's catchup re-encrypt
 * (`writeVerifiedMirrorObject` in `src/fs/mirror-ops.ts`), and
 * `sanity_check` (`src/fs/sanity-check.ts`). Each used to assemble this
 * same read -> `countingReadable` -> `encryptStream` -> (optionally)
 * `UploadChecksumTap` chain separately; this is the single place it is
 * built now.
 *
 * Convergent encryption (the object key and every chunk's nonce derive
 * from the master key and `hash` alone -- see
 * docs/architecture/vault-and-encryption.md) is what makes the ciphertext
 * checksum this produces comparable against whatever S3 actually stored
 * for the same hash: identical content always encrypts to identical
 * bytes, so there is nothing else for the two to disagree about.
 */
export function encryptFileForObject(
  absolutePath: string,
  size: number,
  masterKey: Buffer,
  hash: string,
  options: EncryptFileOptions,
): EncryptedFile {
  const { onBytes, signal, hashMismatch, checksum } = options;
  const source = fs.createReadStream(absolutePath);
  const counted = onBytes ? countingReadable(source, onBytes) : source;

  let reportedHash: string | undefined;
  const encryptOptions: EncryptStreamOptions =
    hashMismatch === "abort"
      ? { ...(signal && { signal }), expectedHash: hash }
      : {
          ...(signal && { signal }),
          onPlaintextHash: (digestHex) => {
            reportedHash = digestHex;
          },
        };

  let ciphertext: Readable = encryptStream(
    counted,
    size,
    masterKey,
    Buffer.from(hash, "hex"),
    encryptOptions,
  );

  let tap: UploadChecksumTap | undefined;
  if (checksum) {
    tap = new UploadChecksumTap();
    ciphertext = tap.tap(ciphertext);
  }

  const settled = new Promise<void>((resolve, reject) => {
    ciphertext.once("end", resolve);
    ciphertext.once("error", reject);
  });

  const result = settled.then(async (): Promise<EncryptFileResult> => ({
    // In "abort" mode, reaching here already proves the content hashed
    // to `hash` -- `expectedHash`'s own assertion inside `encryptStream`
    // is what would have rejected `settled` instead, before `ciphertext`
    // ever reached 'end'.
    plaintextHash: hashMismatch === "abort" ? hash : reportedHash!,
    ciphertextChecksum: tap ? await tap.checksum() : null,
  }));
  // A caller that only drains `ciphertext` itself (sanity_check, draining
  // it to nothing) must not crash the process over `result` going
  // unobserved -- its own consumer already sees the same failure through
  // `ciphertext`'s own 'error' event. Registering a handler here is enough
  // to satisfy Node's unhandled-rejection check regardless of whether the
  // caller also awaits `result` itself.
  result.catch(() => {});

  return { ciphertext, result };
}
