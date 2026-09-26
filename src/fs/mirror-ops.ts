import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";
import { ObjectsRepository, type ObjectRow } from "../db/repositories/objects-repository.js";
import { HASH_BYTES, isValidHashHex } from "../crypto/hash.js";
import { UploadChecksumTap } from "../s3/checksum.js";
import { isInTreeTempName, inTreeTempPath } from "./temp-path.js";
import { renameWithRetry } from "./safe-fs.js";
import { encryptStream, encryptedSize } from "../crypto/streaming-codec.js";
import { pipeline } from "node:stream/promises";
import {
  mirrorObjectPath,
  mirrorStateSnapshotPath,
  mirrorCurrentPointerPath,
  mirrorVaultManifestPath,
} from "../vault/mirror-paths.js";
import { localVaultJsonPath } from "../vault/local-dir.js";
import type { Readable } from "node:stream";

/**
 * How far a check reads. `presence` stats each object and compares size --
 * seconds over tens of thousands of them, since `encryptedSize` is a pure
 * function. `checksum` additionally hashes every stored byte, which reads
 * the entire mirror and is therefore opt-in.
 *
 * The same shallow/deep split `sanity_check` already makes for S3, where it
 * HEADs rather than downloading.
 */
export type MirrorVerifyDepth = "presence" | "checksum";

export interface MirrorVerifyStats {
  /** The version the mirror itself claims, from its own `current`. */
  mirrorVersion: string;
  /** What that was compared against, and where it came from. */
  referenceVersion: string | null;
  reference: "s3" | "local";
  upToDate: boolean;
  objectsChecked: number;
  missing: number;
  wrongSize: number;
  checksumMismatch: number;
  /** Object files present on the mirror that this snapshot doesn't reference. */
  extra: number;
  /** Orphaned `.sync1-tmp-*` left by an interrupted write. */
  staleTemps: number;
}

export class MirrorCheckError extends Error {}

/**
 * Fails unless the mirror's `vault.json` is byte-identical to the local
 * one.
 *
 * Run before anything else, because it is the failure most likely to go
 * unnoticed and the one that invalidates every later result: a different
 * salt or verifier means the drive belongs to a *different vault*, and
 * every object then legitimately "missing" would be reported as corruption
 * of this one.
 */
export function assertMirrorVaultMatches(mirrorPath: string, root: string): void {
  const mirrorManifest = mirrorVaultManifestPath(mirrorPath);
  if (!fs.existsSync(mirrorManifest)) {
    throw new MirrorCheckError(
      `the mirror at "${mirrorPath}" has no vault.json -- without the salt and verifier it cannot be decrypted at all, whatever else it holds; run \`sync1 mirror catchup\``,
    );
  }
  if (!fs.readFileSync(mirrorManifest).equals(fs.readFileSync(localVaultJsonPath(root)))) {
    throw new MirrorCheckError(
      `the mirror at "${mirrorPath}" has a different vault.json than this root -- it belongs to another vault, and checking it against this one would report every object as missing`,
    );
  }
}

/**
 * The version the mirror advertises, having first confirmed it can back the
 * claim up.
 *
 * A `current` naming a snapshot the drive does not hold is fatal on its own
 * and reported as such, rather than as the tens of thousands of
 * missing-object rows it would otherwise produce -- the mirror is
 * unrestorable either way, but only one of those two messages says why.
 */
export function readMirrorVersion(mirrorPath: string): string {
  const pointerPath = mirrorCurrentPointerPath(mirrorPath);
  if (!fs.existsSync(pointerPath)) {
    throw new MirrorCheckError(
      `the mirror at "${mirrorPath}" has no current pointer, so nothing identifies which snapshot it holds; run \`sync1 mirror catchup\``,
    );
  }
  const versionStamp = fs.readFileSync(pointerPath, "utf8").trim();
  const snapshotPath = mirrorStateSnapshotPath(mirrorPath, versionStamp);
  if (!fs.existsSync(snapshotPath) || fs.statSync(snapshotPath).size === 0) {
    throw new MirrorCheckError(
      `the mirror's current pointer names version ${versionStamp}, but states/${versionStamp} is missing or empty -- the mirror cannot be restored from at all; run \`sync1 mirror catchup\``,
    );
  }
  return versionStamp;
}

/**
 * Checks every object **the mirror's own snapshot references**, not the
 * local state.db's.
 *
 * The question a backup has to answer is "is this drive, by itself, a
 * complete and restorable copy?" -- not "does it agree with this machine".
 * Measuring against the local database instead would render a legitimately
 * behind mirror as an unexplained heap of missing objects, and would
 * measure against a broken ruler if that database were itself corrupt or
 * from another vault.
 *
 * Streams throughout and holds only counters: a first sync leaves every
 * object in the vault to check, so a retained list of findings is not an
 * option. Per-path detail goes to the log.
 */
export async function verifyMirrorObjects(
  mirrorPath: string,
  snapshotDb: import("better-sqlite3").Database,
  depth: MirrorVerifyDepth,
  logger: Logger,
  onProgress?: (checked: number) => void,
): Promise<
  Pick<MirrorVerifyStats, "objectsChecked" | "missing" | "wrongSize" | "checksumMismatch">
> {
  const objectsRepo = new ObjectsRepository(snapshotDb);
  let objectsChecked = 0;
  let missing = 0;
  let wrongSize = 0;
  let checksumMismatch = 0;

  for (const row of objectsRepo.iterateAll()) {
    objectsChecked++;
    onProgress?.(objectsChecked);

    const target = mirrorObjectPath(mirrorPath, row.hash);
    const expectedSize = encryptedSize(row.size, HASH_BYTES);

    let actualSize: number;
    try {
      actualSize = fs.statSync(target).size;
    } catch {
      missing++;
      logger.warn({ hash: row.hash, target }, "object missing from the mirror");
      continue;
    }

    if (actualSize !== expectedSize) {
      wrongSize++;
      logger.warn(
        { hash: row.hash, target, expectedSize, actualSize },
        "object on the mirror is the wrong size -- truncated or overwritten",
      );
      continue;
    }

    if (depth === "checksum" && !(await ciphertextMatches(target, row.ciphertext_checksum))) {
      checksumMismatch++;
      logger.warn(
        { hash: row.hash, target, expected: row.ciphertext_checksum },
        "object on the mirror does not match its recorded checksum -- the bytes have rotted or been altered",
      );
    }
  }

  return { objectsChecked, missing, wrongSize, checksumMismatch };
}

/**
 * Re-reads a stored object and compares it to the checksum recorded at
 * upload time.
 *
 * That number is **S3-corroborated**: `putObjectStream` refuses to return
 * unless S3's own independently-computed CRC64NVME matched the client's. So
 * this compares the mirror against a value S3 agreed to, without touching
 * S3 -- which is what makes a fully offline deep check meaningful rather
 * than merely self-consistent.
 */
async function ciphertextMatches(
  absolutePath: string,
  expected: string,
): Promise<string | boolean> {
  const tap = new UploadChecksumTap();
  const tapped = tap.tap(fs.createReadStream(absolutePath) as unknown as Readable);
  for await (const _chunk of tapped) {
    // draining is what feeds the tap
  }
  return (await tap.checksum()) === expected;
}

export interface MirrorObjectFile {
  absolutePath: string;
  hash: string;
  size: number;
}

/**
 * Every file under the mirror's `objects/` tree, with the hash its name
 * claims.
 *
 * A generator, and looked up one at a time by the callers, precisely so
 * neither `verify` nor `prune` ever builds the set of expected hashes in
 * memory. On a vault of tens of thousands of objects that set would be the
 * single largest allocation either command made, for a question a primary
 * key lookup answers in constant time.
 */
export function* walkMirrorObjects(mirrorPath: string): Generator<MirrorObjectFile> {
  const objectsRoot = path.join(mirrorPath, "objects");
  if (!fs.existsSync(objectsRoot)) return;

  const stack = [objectsRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && !isInTreeTempName(entry.name)) {
        // The filename *is* the hash -- anything else under objects/ was
        // not put there by sync1 and is deliberately left alone rather
        // than guessed at.
        if (isValidHashHex(entry.name)) {
          yield { absolutePath: full, hash: entry.name, size: fs.statSync(full).size };
        }
      }
    }
  }
}

/** Orphaned staging files, from a write interrupted between its temp and its rename. */
export function* walkMirrorTemps(mirrorPath: string): Generator<string> {
  if (!fs.existsSync(mirrorPath)) return;
  const stack = [mirrorPath];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && isInTreeTempName(entry.name)) yield full;
    }
  }
}

/**
 * Object files the given snapshot does not reference.
 *
 * "Extra" is not the same as "wrong". `gc`'s scope is the current live
 * state, so an object dropped from the vault is deleted from S3 but kept
 * here -- deliberately, since that is the mirror's value as a safety net
 * against a mistaken delete. Reporting them is how you find out space can
 * be reclaimed; `mirror prune` is the separate, opt-in decision to do it.
 */
export function* findExtraMirrorObjects(
  mirrorPath: string,
  snapshotDb: import("better-sqlite3").Database,
): Generator<MirrorObjectFile> {
  const objectsRepo = new ObjectsRepository(snapshotDb);
  for (const file of walkMirrorObjects(mirrorPath)) {
    if (!objectsRepo.has(file.hash)) yield file;
  }
}

/**
 * Re-encrypts a local plaintext file and publishes it to the mirror, but
 * only if it proves to be the content the object claims.
 *
 * **Two ends checked in a single pass, with the rename as the gate.** The
 * one read feeds `encryptStream`'s own `expectedHash` over the plaintext
 * and a `UploadChecksumTap` over the ciphertext. BLAKE2b must equal the
 * object's hash -- proving the right content was encrypted -- *and* the
 * CRC64NVME must equal what S3 corroborated at upload time, proving the
 * bytes this produced are the bytes the bucket holds. Either fails and the
 * temp is discarded without ever being renamed.
 *
 * Without this, catchup would be a silent-corruption engine. `objects` has
 * no path column, so a source is found through `entries.hash`
 * (many-to-one), and that path may have been edited since it was synced.
 * Encrypting it anyway would write ciphertext for *different* content into
 * `objects/../<H>` -- a file that passes the cheap size check and decrypts
 * to the wrong bytes. Strictly worse than the hole it replaced.
 *
 * Returns false when the source did not match, so the caller can try the
 * next path referencing the same object rather than giving up.
 */
export async function writeVerifiedMirrorObject(
  mirrorPath: string,
  row: ObjectRow,
  sourceAbsolutePath: string,
  masterKey: Buffer,
): Promise<boolean> {
  const target = mirrorObjectPath(mirrorPath, row.hash);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tempPath = inTreeTempPath(target);

  const tap = new UploadChecksumTap();
  try {
    const encrypted = encryptStream(
      fs.createReadStream(sourceAbsolutePath),
      row.size,
      masterKey,
      Buffer.from(row.hash, "hex"),
      { expectedHash: row.hash },
    );
    await pipeline(tap.tap(encrypted), fs.createWriteStream(tempPath));
  } catch {
    // A plaintext mismatch or a size change aborts the stream, which is
    // the intended outcome, not an error to propagate: this source simply
    // is not the content, and the caller has others to try.
    removeQuietly(tempPath);
    return false;
  }

  if ((await tap.checksum()) !== row.ciphertext_checksum) {
    removeQuietly(tempPath);
    return false;
  }

  await renameWithRetry(tempPath, target);
  return true;
}

function removeQuietly(tempPath: string): void {
  try {
    fs.rmSync(tempPath, { force: true });
  } catch {
    // The reason the caller needs is the original failure, not this one.
  }
}

/**
 * Downloads an object's ciphertext from S3 straight onto the mirror.
 *
 * The last resort in catchup's ladder, and the only step that costs
 * egress -- which is why it is gated behind an explicit flag. Nothing is
 * re-encrypted here: S3 already holds the exact bytes the mirror wants, so
 * they are streamed through unchanged.
 *
 * Verified before publication all the same, against the same
 * S3-corroborated checksum the local path uses. A download can be
 * truncated or corrupted in transit, and a mirror is precisely the place
 * where nobody would notice for years.
 */
export async function downloadObjectToMirror(
  mirrorPath: string,
  row: ObjectRow,
  body: Readable,
): Promise<boolean> {
  const target = mirrorObjectPath(mirrorPath, row.hash);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tempPath = inTreeTempPath(target);

  const tap = new UploadChecksumTap();
  try {
    await pipeline(tap.tap(body), fs.createWriteStream(tempPath));
  } catch {
    removeQuietly(tempPath);
    throw new Error(`download of object ${row.hash} failed partway`);
  }

  if ((await tap.checksum()) !== row.ciphertext_checksum) {
    removeQuietly(tempPath);
    return false;
  }

  await renameWithRetry(tempPath, target);
  return true;
}

export type { ObjectRow };
