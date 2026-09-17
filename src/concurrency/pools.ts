import PQueue from "p-queue";
import { Piscina } from "piscina";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createHashRunner, type HashRunner } from "./hash-runner.js";

export interface ConcurrencyPools {
  s3: PQueue;
  hash: Piscina;
  /**
   * The seam callers actually dispatch hashing through -- `hash` itself
   * stays exposed only for its `maxThreads` (the natural in-flight limit)
   * and `close()`. Going through the adapter is what carries per-file byte
   * progress back out of the worker thread; see `createHashRunner`.
   */
  hashRunner: HashRunner;
  stream: PQueue;
  thumbnail: PQueue;
}

export interface ConcurrencyPoolOptions {
  s3MetadataParallelism?: number;
  hashParallelism?: number;
  fileStreamParallelism?: number;
  thumbnailParallelism?: number;
}

export function createConcurrencyPools(opts: ConcurrencyPoolOptions): ConcurrencyPools {
  const hash = new Piscina({
    filename: fileURLToPath(new URL("./hash-worker.js", import.meta.url)),
    maxThreads: opts.hashParallelism ?? os.cpus().length,
  });
  return {
    s3: new PQueue({ concurrency: opts.s3MetadataParallelism ?? 8 }),
    hash,
    hashRunner: createHashRunner(hash),
    stream: new PQueue({ concurrency: opts.fileStreamParallelism ?? 4 }),
    thumbnail: new PQueue({ concurrency: opts.thumbnailParallelism ?? 4 }),
  };
}

// Keeps a p-queue-backed pool's producer from getting more than `limit` jobs
// ahead of what the pool can actually run -- an unbounded producer feeding a
// pool is just as unbounded as loading everything into an array up front.
export async function waitForRoom(pool: PQueue, limit: number): Promise<void> {
  if (pool.size + pool.pending >= limit) {
    await pool.onSizeLessThan(limit);
  }
}

/**
 * Same backpressure discipline as `waitForRoom`, for a pool with no
 * `onSizeLessThan`-style primitive of its own (the piscina hash pool, in
 * particular): tracks dispatched-but-not-yet-settled tasks in a bounded set,
 * capped at `limit`. `dispatch()` resolves once a task has been *started*
 * (after waiting for room if needed), not once it *completes* -- that's what
 * lets a producer (a merge-join loop, say) fire a task and immediately move
 * on to the next item, while still never getting more than `limit` jobs
 * ahead of what's actually running. `onIdle()` is the join step: it resolves
 * once every dispatched task has settled, and rejects if any of them did.
 */
export class BoundedTaskTracker {
  private readonly inFlight = new Set<Promise<unknown>>();
  private hasError = false;
  private firstError: unknown;

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.inFlight.size;
  }

  async dispatch(task: () => Promise<unknown>): Promise<void> {
    while (this.inFlight.size >= this.limit) {
      await Promise.race(this.inFlight);
    }
    // Caught here, not left to reject `tracked` itself: a task can settle
    // (and get removed from `inFlight`, below) well before anyone calls
    // onIdle() to observe it, which would otherwise surface as an unhandled
    // rejection -- the error is stashed and re-thrown from onIdle() instead.
    const tracked: Promise<unknown> = task()
      .catch((err: unknown) => {
        if (!this.hasError) {
          this.hasError = true;
          this.firstError = err;
        }
      })
      .finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  async onIdle(): Promise<void> {
    await Promise.all(this.inFlight);
    if (this.hasError) throw this.firstError;
  }
}
