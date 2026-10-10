// Runs INSIDE a piscina worker thread (see src/concurrency/pools.ts) --
// genuine multi-core parallelism for hashing many *different* files, since
// each file's BLAKE2b hash is independent, computed from a plain file path
// with no shared state and a tiny (hex string) result. `better-sqlite3`
// connections aren't transferable across threads, so this worker never
// touches any database -- it's given a path, it returns a hash, nothing else.
import { hashFile } from "../fs/hash-file.js";
import { encryptFileForObject } from "../fs/encrypt-file.js";

export interface HashFileTask {
  absolutePath: string;
  /**
   * An 8-byte buffer holding this file's running byte count, shared with
   * the main thread (see `createHashRunner`), which samples it on a timer
   * to advance the progress bar. Optional: a caller that isn't rendering
   * progress omits it and this worker never writes anything.
   *
   * Shared memory rather than a MessageChannel deliberately. A port would
   * have to be transferred in, listened to, and closed on every exit path
   * -- including the ones where the task rejects before the handler even
   * runs, which leaks the worker-side port and hangs pool shutdown. A
   * SharedArrayBuffer has none of that: it is plain memory that gets
   * garbage-collected. It also moves the throttling decision to the
   * reader, which can sample at the bar's own render rate instead of
   * making the writer guess at a chunk interval. Piscina's own port is
   * off-limits regardless -- it keys messages by task id, and an extra
   * message on it desyncs the pool's bookkeeping.
   */
  progress?: SharedArrayBuffer;
}

export default function hashFileTask(task: HashFileTask): Promise<string> {
  if (!task.progress) return hashFile(task.absolutePath);

  // BigInt64Array, not Int32Array: this vault exists to hold multi-GB
  // video, and a 32-bit counter silently wraps at 2.1GB -- which would
  // show up as a progress bar that runs backwards on exactly the files
  // this feature is for.
  const counter = new BigInt64Array(task.progress);
  let total = 0n;
  return hashFile(task.absolutePath, (n) => {
    total += BigInt(n);
    Atomics.store(counter, 0, total);
  });
}

export interface ChecksumFileTask {
  absolutePath: string;
  size: number;
  /** The hash `state.db` recorded for this path -- the encryption context/key, not asserted against. */
  hash: string;
  /** Structured-cloned across the worker boundary; re-wrapped as a Buffer below. */
  masterKey: Uint8Array;
  /** Same shared-memory byte counter as `HashFileTask.progress` -- see its own doc comment. */
  progress?: SharedArrayBuffer;
}

export interface ChecksumFileResult {
  plaintextHash: string;
  ciphertextChecksum: string | null;
}

/**
 * `sanity_check`'s single read (BLAKE2b, then re-encrypt, then CRC64NVME --
 * see `encryptFileForObject`, src/fs/encrypt-file.ts), run on a worker
 * thread for the same reason `hashFileTask` above does: each file is
 * independent, and the CRC64NVME pass in particular is pure-JS and
 * CPU-bound (confirmed: ~240 MiB/s on one core, versus ~1100+ MiB/s for
 * the BLAKE2b/XChaCha20 passes either side of it), so spreading different
 * files' reads across real threads is a genuine multi-core win rather than
 * contending over one.
 *
 * `hashMismatch: "report"` (never aborts on a mismatch -- sanity_check
 * wants to learn the actual hash) and `checksum: true` (always; that's the
 * whole point here) are fixed, matching `LocalReader`'s production binding
 * in src/commands/sanity_check.ts. `ciphertext` is drained to nothing: this
 * task only wants the two checksums `result` resolves with.
 */
export async function checksumFileTask(task: ChecksumFileTask): Promise<ChecksumFileResult> {
  const onBytes = task.progress
    ? (() => {
        const counter = new BigInt64Array(task.progress);
        let total = 0n;
        return (n: number): void => {
          total += BigInt(n);
          Atomics.store(counter, 0, total);
        };
      })()
    : undefined;

  const { ciphertext, result } = encryptFileForObject(
    task.absolutePath,
    task.size,
    Buffer.from(task.masterKey),
    task.hash,
    { ...(onBytes && { onBytes }), hashMismatch: "report", checksum: true },
  );
  ciphertext.resume();
  return result;
}
