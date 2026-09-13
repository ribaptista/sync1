import { describe, it, expect, vi } from "vitest";
import PQueue from "p-queue";
import os from "node:os";

// createConcurrencyPools eagerly constructs a real Piscina pool, which spawns
// worker threads that try to load hash-worker's *compiled* .js sibling --
// that file only exists after `npm run build`, not when running unit tests
// straight against src/. Mock Piscina here so this test can verify the
// factory's defaulting/override logic (p-queue's own concurrency behavior is
// already p-queue's tested responsibility) without spawning real threads.
const piscinaCtor = vi.fn();
vi.mock("piscina", () => ({
  Piscina: vi.fn().mockImplementation((...args: unknown[]) => {
    piscinaCtor(...args);
    const [options] = args as [{ maxThreads?: number }];
    return { maxThreads: options.maxThreads };
  }),
}));

const { createConcurrencyPools, waitForRoom, BoundedHashRunner } =
  await import("../../../src/concurrency/pools.js");

describe("createConcurrencyPools", () => {
  it("defaults s3 and stream concurrency, and hash maxThreads, when no options given", () => {
    const pools = createConcurrencyPools({});
    expect(pools.s3.concurrency).toBe(8);
    expect(pools.stream.concurrency).toBe(4);
    expect(pools.hash.maxThreads).toBe(os.cpus().length);
  });

  it("honors explicit overrides for every knob", () => {
    const pools = createConcurrencyPools({
      s3MetadataParallelism: 2,
      fileStreamParallelism: 3,
      hashParallelism: 5,
    });
    expect(pools.s3.concurrency).toBe(2);
    expect(pools.stream.concurrency).toBe(3);
    expect(pools.hash.maxThreads).toBe(5);
  });
});

describe("waitForRoom", () => {
  it("resolves immediately when the pool has room", async () => {
    const pool = new PQueue({ concurrency: 2 });
    await expect(waitForRoom(pool, 4)).resolves.toBeUndefined();
  });

  it("waits until the pool's size drops back below the limit", async () => {
    const pool = new PQueue({ concurrency: 1 });
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => (release = resolve));
    void pool.add(() => blocker);
    void pool.add(() => Promise.resolve());

    let resolved = false;
    const waiting = waitForRoom(pool, 2).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    release();
    await waiting;
    expect(resolved).toBe(true);
  });
});

describe("BoundedHashRunner", () => {
  it("never has more than `limit` runs in flight at once", async () => {
    const releases: (() => void)[] = [];
    const fakePool = {
      run: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            releases.push(() => resolve("hash"));
          }),
      ),
    };
    const runner = new BoundedHashRunner(fakePool, 2);

    const p1 = runner.run("/a");
    const p2 = runner.run("/b");
    await Promise.resolve();
    expect(runner.size).toBe(2);

    let thirdDispatched = false;
    const p3 = runner.run("/c").then((r) => {
      thirdDispatched = true;
      return r;
    });
    await Promise.resolve();
    expect(fakePool.run).toHaveBeenCalledTimes(2);
    expect(thirdDispatched).toBe(false);

    releases[0]!();
    await p1;
    // Only after "/a" settles does room open up for "/c" to actually dispatch.
    await vi.waitFor(() => expect(fakePool.run).toHaveBeenCalledTimes(3));
    expect(thirdDispatched).toBe(false);

    releases[2]!();
    await p3;
    expect(thirdDispatched).toBe(true);

    releases[1]!();
    await p2;
  });

  it("onIdle resolves only once every dispatched run has settled", async () => {
    const fakePool = { run: vi.fn(() => Promise.resolve("hash")) };
    const runner = new BoundedHashRunner(fakePool, 4);
    await runner.run("/a");
    await runner.run("/b");
    await expect(runner.onIdle()).resolves.toBeUndefined();
    expect(runner.size).toBe(0);
  });
});
