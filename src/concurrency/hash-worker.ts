// Runs INSIDE a piscina worker thread (see src/concurrency/pools.ts) --
// genuine multi-core parallelism for hashing many *different* files, since
// each file's BLAKE2b hash is independent, computed from a plain file path
// with no shared state and a tiny (hex string) result. `better-sqlite3`
// connections aren't transferable across threads, so this worker never
// touches any database -- it's given a path, it returns a hash, nothing else.
import { hashFile } from "../fs/hash-file.js";

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
