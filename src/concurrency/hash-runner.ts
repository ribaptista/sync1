import type { Piscina } from "piscina";
import type { HashFileTask, ChecksumFileTask, ChecksumFileResult } from "./hash-worker.js";

/**
 * The "hash one file" seam that update_cache/sanity_check/stubify dispatch
 * to. Production passes `createHashRunner(pool)` below; unit tests inject a
 * fake, synchronous-ish in-process implementation instead of a real
 * worker-thread pool.
 *
 * `run` is declared as a **property**, not a method, on purpose. Method
 * syntax is checked bivariantly even under `strict`, so a bare `Piscina`
 * (whose own `run(task, options?)` takes an options object second) would
 * still structurally satisfy this interface after `onBytes` was added --
 * compiling cleanly while passing a *function* where piscina expects its
 * options. A property makes `strictFunctionTypes` apply contravariantly, so
 * anything but a real adapter is a compile error.
 */
export interface HashRunner {
  run: (absolutePath: string, onBytes?: (bytes: number) => void) => Promise<string>;
}

/**
 * How often the main thread samples a running hash's shared byte counter.
 * Matched to cli-progress's own default 10fps redraw: sampling faster would
 * only produce updates the bar throttles away again, and slower would make
 * a fast local disk look like it was stalling between ticks.
 */
const SAMPLE_INTERVAL_MS = 100;

/**
 * The worker can't call back into the main thread's progress bar, so a task
 * that accepts a `progress` `SharedArrayBuffer` (see `hash-worker.ts` for
 * why shared memory rather than a MessageChannel) writes its running total
 * into it, and this samples that buffer on a timer, reporting the delta
 * since last time. `onBytes` therefore stays a plain "n more bytes"
 * callback, matching every other byte source in the codebase, and the
 * worker never needs to know anything about how often the bar redraws.
 *
 * The timer is `unref`'d so a pending sample can never hold the process
 * open, and a final sample runs in `finally` so the last sub-interval of a
 * file isn't silently dropped. Shared by `createHashRunner` and
 * `createChecksumRunner` below -- both dispatch a progress-reporting task
 * through this exact same sampling loop, differing only in which task they
 * run and what they do with its result.
 */
async function runWithSampledProgress<T>(
  runTask: (progress: SharedArrayBuffer) => Promise<T>,
  onBytes: (bytes: number) => void,
): Promise<T> {
  const progress = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
  const counter = new BigInt64Array(progress);
  let reported = 0n;
  const sample = (): void => {
    const current = Atomics.load(counter, 0);
    if (current > reported) {
      onBytes(Number(current - reported));
      reported = current;
    }
  };

  const timer = setInterval(sample, SAMPLE_INTERVAL_MS);
  timer.unref();
  try {
    return await runTask(progress);
  } finally {
    clearInterval(timer);
    sample();
  }
}

/** Adapts the piscina pool to `HashRunner`, adding live byte progress for a file being hashed off-thread. */
export function createHashRunner(pool: Piscina): HashRunner {
  return {
    run: async (absolutePath, onBytes) => {
      if (!onBytes) {
        return (await pool.run({ absolutePath } satisfies HashFileTask)) as string;
      }
      return runWithSampledProgress(
        (progress) =>
          pool.run({ absolutePath, progress } satisfies HashFileTask) as Promise<string>,
        onBytes,
      );
    },
  };
}

/**
 * The "read, re-encrypt, checksum" seam `sanity_check` dispatches through
 * (its `LocalReader` type, src/fs/sanity-check.ts) -- bound to the vault's
 * master key once, here, rather than per call. Production passes
 * `createChecksumRunner(pools.hash, masterKey)` (src/commands/
 * sanity_check.ts); unit tests inject a fake in-process `LocalReader`
 * directly instead of a real worker-thread pool.
 *
 * Dispatches to `checksumFileTask` (`hash-worker.ts`) by its *name* --
 * `pool.run(task, { name: ... })` -- since `hash-worker.ts`'s default
 * export is still `hashFileTask`, used by `createHashRunner` above; the
 * same worker file serves both named tasks, loaded once per pool.
 */
export function createChecksumRunner(
  pool: Piscina,
  masterKey: Buffer,
): (
  absolutePath: string,
  size: number,
  hash: string,
  onBytes: (bytes: number) => void,
) => Promise<{ plaintextHash: string; ciphertextChecksum: string }> {
  const masterKeyBytes = new Uint8Array(masterKey);
  return async (absolutePath, size, hash, onBytes) => {
    const run = (progress?: SharedArrayBuffer): Promise<ChecksumFileResult> =>
      pool.run(
        {
          absolutePath,
          size,
          hash,
          masterKey: masterKeyBytes,
          ...(progress && { progress }),
        } satisfies ChecksumFileTask,
        { name: "checksumFileTask" },
      ) as Promise<ChecksumFileResult>;
    const { plaintextHash, ciphertextChecksum } = await runWithSampledProgress(run, onBytes);
    // `checksum: true` is fixed above, so a successful task always carries
    // one -- `ciphertextChecksum` is `string | null` only because
    // `EncryptFileResult` (src/fs/encrypt-file.ts) is shared with the
    // `checksum: false` callers (sync's upload), which this is not.
    return { plaintextHash, ciphertextChecksum: ciphertextChecksum! };
  };
}
