import type { Piscina } from "piscina";
import type { HashFileTask } from "./hash-worker.js";

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
 * Adapts the piscina pool to `HashRunner`, adding live byte progress for a
 * file being hashed off-thread.
 *
 * The worker can't call back into the main thread's progress bar, so it
 * writes its running total into a shared 8-byte buffer (see
 * `hash-worker.ts` for why shared memory rather than a MessageChannel) and
 * this samples that buffer on a timer, reporting the delta since last time.
 * `onBytes` therefore stays a plain "n more bytes" callback, matching every
 * other byte source in the codebase, and the worker never needs to know
 * anything about how often the bar redraws.
 *
 * The timer is `unref`'d so a pending sample can never hold the process
 * open, and a final sample runs in `finally` so the last sub-interval of a
 * file isn't silently dropped.
 */
export function createHashRunner(pool: Piscina): HashRunner {
  return {
    run: async (absolutePath, onBytes) => {
      if (!onBytes) {
        return (await pool.run({ absolutePath } satisfies HashFileTask)) as string;
      }

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
        return (await pool.run({ absolutePath, progress } satisfies HashFileTask)) as string;
      } finally {
        clearInterval(timer);
        sample();
      }
    },
  };
}
