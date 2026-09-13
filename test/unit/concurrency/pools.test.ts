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

const { createConcurrencyPools, waitForRoom, BoundedTaskTracker } =
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

describe("BoundedTaskTracker", () => {
  it("never has more than `limit` tasks in flight, and dispatch() resolves on start, not completion", async () => {
    const releases: (() => void)[] = [];
    const taskFn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releases.push(() => resolve("done"));
        }),
    );
    const tracker = new BoundedTaskTracker(2);

    await tracker.dispatch(taskFn);
    await tracker.dispatch(taskFn);
    expect(tracker.size).toBe(2);
    expect(taskFn).toHaveBeenCalledTimes(2);

    let thirdDispatched = false;
    const dispatchingThird = tracker.dispatch(taskFn).then(() => {
      thirdDispatched = true;
    });
    await Promise.resolve();
    expect(taskFn).toHaveBeenCalledTimes(2); // still waiting for room
    expect(thirdDispatched).toBe(false);

    releases[0]!();
    // Only after the first task settles does room open up for the third to dispatch.
    await dispatchingThird;
    expect(thirdDispatched).toBe(true);
    expect(taskFn).toHaveBeenCalledTimes(3);

    releases[1]!();
    releases[2]!();
    await tracker.onIdle();
  });

  it("onIdle resolves only once every dispatched task has settled", async () => {
    const tracker = new BoundedTaskTracker(4);
    await tracker.dispatch(() => Promise.resolve("a"));
    await tracker.dispatch(() => Promise.resolve("b"));
    await expect(tracker.onIdle()).resolves.toBeUndefined();
    expect(tracker.size).toBe(0);
  });

  it("onIdle propagates a rejection from any dispatched task", async () => {
    const tracker = new BoundedTaskTracker(4);
    await tracker.dispatch(() => Promise.reject(new Error("hash failed: ENOENT")));
    await expect(tracker.onIdle()).rejects.toThrow("hash failed: ENOENT");
  });
});
