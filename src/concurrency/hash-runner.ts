/**
 * The "hash one file" seam that update_cache/sanity_check/stubify dispatch
 * to. Production passes the real piscina pool (which already satisfies this
 * shape via its own `run()`); unit tests inject a fake, synchronous-ish
 * in-process implementation instead of a real worker-thread pool.
 */
export interface HashRunner {
  run(absolutePath: string): Promise<string>;
}
