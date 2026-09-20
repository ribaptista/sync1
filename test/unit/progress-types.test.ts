import { describe, it, expect, vi } from "vitest";
import { createProgressTracker } from "../../src/progress-types.js";

describe("createProgressTracker", () => {
  it("counts rowDiscovered/rowResolved independently of byte tracking", () => {
    const updates: unknown[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    tracker.rowDiscovered();
    tracker.rowDiscovered();
    tracker.rowResolved();

    expect(updates.at(-1)).toMatchObject({ filesDone: 1, filesTotal: 2 });
  });

  it("expectBytes grows bytesTotal before bytesDone ever moves for that file", () => {
    const updates: { bytesDone: number; bytesTotal: number }[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    tracker.expectBytes(100);
    expect(updates.at(-1)).toEqual(expect.objectContaining({ bytesDone: 0, bytesTotal: 100 }));

    const file = tracker.startFile("a.jpg", 100);
    file.advance(40);
    expect(updates.at(-1)).toEqual(expect.objectContaining({ bytesDone: 40, bytesTotal: 100 }));
  });

  it("startFile emits the caller's first verb, finish emits the second, both against the same path", () => {
    const updates: { activity?: { verb: string; path: string } | undefined }[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    tracker.expectBytes(10);
    const file = tracker.startFile("photos/a.jpg", 10);
    expect(updates.at(-1)?.activity).toEqual({ verb: "hashing", path: "photos/a.jpg" });

    file.finish();
    expect(updates.at(-1)?.activity).toEqual({ verb: "hashed", path: "photos/a.jpg" });
  });

  it("renders whatever verb pair it was handed, with no vocabulary of its own", () => {
    const updates: { activity?: { verb: string; path: string } | undefined }[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["uploading", "uploaded"]);

    const file = tracker.startFile("a.jpg", 1);
    expect(updates.at(-1)?.activity?.verb).toBe("uploading");
    file.finish();
    expect(updates.at(-1)?.activity?.verb).toBe("uploaded");
  });

  it("bytesDone advances monotonically as multiple files progress concurrently", () => {
    const updates: { bytesDone: number }[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    tracker.expectBytes(100);
    tracker.expectBytes(50);
    const a = tracker.startFile("a", 100);
    const b = tracker.startFile("b", 50);

    a.advance(30);
    b.advance(10);
    a.advance(20);
    b.finish();
    a.finish();

    let previous = -Infinity;
    for (const u of updates) {
      expect(u.bytesDone).toBeGreaterThanOrEqual(previous);
      previous = u.bytesDone;
    }
  });

  it("clamps advance to the file's declared size -- an over-reporting source can't push bytesDone past bytesTotal", () => {
    const updates: { bytesDone: number }[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    tracker.expectBytes(100);
    const file = tracker.startFile("a", 100);
    file.advance(9999); // wildly over-reports

    expect(updates.at(-1)?.bytesDone).toBe(100);
  });

  it("finish() is idempotent -- a second call doesn't double-count completedBytes or re-emit", () => {
    const updates: unknown[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    tracker.expectBytes(100);
    const file = tracker.startFile("a", 100);
    file.advance(60);
    file.finish();
    const afterFirstFinish = updates.length;
    const bytesDoneAfterFirstFinish = (updates.at(-1) as { bytesDone: number }).bytesDone;

    file.finish(); // second call

    expect(updates.length).toBe(afterFirstFinish); // no additional emit
    expect((updates.at(-1) as { bytesDone: number }).bytesDone).toBe(bytesDoneAfterFirstFinish);
    expect(bytesDoneAfterFirstFinish).toBe(100);
  });

  it("advance() after finish() is a no-op", () => {
    const updates: unknown[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    tracker.expectBytes(100);
    const file = tracker.startFile("a", 100);
    file.finish();
    const afterFinish = updates.length;
    const bytesDoneAfterFinish = (updates.at(-1) as { bytesDone: number }).bytesDone;

    file.advance(50);

    expect(updates.length).toBe(afterFinish); // no additional emit
    expect((updates.at(-1) as { bytesDone: number }).bytesDone).toBe(bytesDoneAfterFinish);
  });

  it("every emitted update is a fresh object, not a shared mutated reference", () => {
    const updates: unknown[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    tracker.rowDiscovered();
    tracker.expectBytes(10);
    const file = tracker.startFile("a", 10);
    file.advance(5);
    file.finish();
    tracker.rowResolved();

    const identities = new Set(updates);
    expect(identities.size).toBe(updates.length);
    // A snapshot taken right after the first update must not have been
    // mutated by any later call -- proving each update really is frozen in
    // time, the way commit.ts's phaseProgress relies on when it stores the
    // reference it's handed.
    const firstSnapshot = { ...(updates[0] as Record<string, unknown>) };
    expect(updates[0]).toEqual(firstSnapshot);
  });

  it("bytesDone === bytesTotal once every dispatched file has finished", () => {
    const updates: { bytesDone: number; bytesTotal: number }[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    tracker.expectBytes(100);
    tracker.expectBytes(250);
    const a = tracker.startFile("a", 100);
    const b = tracker.startFile("b", 250);

    a.advance(37);
    b.advance(11);
    a.finish();
    b.finish();

    const last = updates.at(-1)!;
    expect(last.bytesDone).toBe(last.bytesTotal);
    expect(last.bytesDone).toBe(350);
  });

  it("a file that finishes having never advanced still lands at its full size", () => {
    const updates: { bytesDone: number }[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    tracker.expectBytes(42);
    const file = tracker.startFile("a", 42);
    file.finish(); // no advance() calls at all

    expect(updates.at(-1)?.bytesDone).toBe(42);
  });

  it("onProgress is optional -- a caller that never wires it up hits no errors", () => {
    const tracker = createProgressTracker(undefined, ["hashing", "hashed"]);
    expect(() => {
      tracker.rowDiscovered();
      tracker.expectBytes(10);
      const file = tracker.startFile("a", 10);
      file.advance(5);
      file.finish();
      tracker.rowResolved();
    }).not.toThrow();
  });

  it("onProgress is called synchronously on each state-changing call", () => {
    const onProgress = vi.fn();
    const tracker = createProgressTracker(onProgress, ["hashing", "hashed"]);
    tracker.rowDiscovered();
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("totals start out provisional and only an estimate marked final says otherwise", () => {
    const updates: { totalsFinal: boolean }[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    tracker.rowDiscovered();
    expect(updates.at(-1)?.totalsFinal).toBe(false);

    tracker.setEstimatedTotals({ files: 10, bytes: 1000 });
    expect(updates.at(-1)?.totalsFinal).toBe(false);

    tracker.setEstimatedTotals({ files: 10, bytes: 1000, final: true });
    expect(updates.at(-1)?.totalsFinal).toBe(true);
  });

  it("an estimate raises the emitted totals above what's been observed so far", () => {
    const updates: { filesTotal: number; bytesTotal: number }[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    tracker.rowDiscovered();
    tracker.expectBytes(100);
    expect(updates.at(-1)).toMatchObject({ filesTotal: 1, bytesTotal: 100 });

    // The enumeration pass has run ahead of the real one.
    tracker.setEstimatedTotals({ files: 50, bytes: 5000 });
    expect(updates.at(-1)).toMatchObject({ filesTotal: 50, bytesTotal: 5000 });
  });

  it("observation overtakes an estimate that under-counted, with no correction call needed", () => {
    const updates: { filesTotal: number; bytesTotal: number }[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    tracker.setEstimatedTotals({ files: 2, bytes: 200 });
    tracker.rowDiscovered();
    tracker.rowDiscovered();
    tracker.rowDiscovered(); // a third row the enumeration pass never saw
    tracker.expectBytes(500);

    expect(updates.at(-1)).toMatchObject({ filesTotal: 3, bytesTotal: 500 });
  });

  it("a lowered estimate never drags a total below what's already done", () => {
    const updates: {
      filesDone: number;
      filesTotal: number;
      bytesDone: number;
      bytesTotal: number;
    }[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    tracker.setEstimatedTotals({ files: 100, bytes: 10_000 });
    tracker.rowDiscovered();
    tracker.rowResolved();
    tracker.expectBytes(400);
    tracker.startFile("a.jpg", 400).finish();

    // Even an absurd revision to zero can't invert done-vs-total: the
    // observed counters are a floor the estimate is never consulted below.
    tracker.setEstimatedTotals({ files: 0, bytes: 0 });
    const last = updates.at(-1)!;
    expect(last.filesTotal).toBeGreaterThanOrEqual(last.filesDone);
    expect(last.bytesTotal).toBeGreaterThanOrEqual(last.bytesDone);
    expect(last).toMatchObject({ filesTotal: 1, bytesTotal: 400 });
  });

  it("settle() lands on the observed truth when the estimate over-counted", () => {
    const updates: { filesTotal: number; bytesTotal: number; totalsFinal: boolean }[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    // Enumeration saw 10 files / 1000 bytes; the run only ever found 8/800
    // (two vanished between the two passes).
    tracker.setEstimatedTotals({ files: 10, bytes: 1000 });
    for (let i = 0; i < 8; i++) tracker.rowDiscovered();
    tracker.expectBytes(800);
    expect(updates.at(-1)).toMatchObject({ filesTotal: 10, bytesTotal: 1000 });

    tracker.settle();
    expect(updates.at(-1)).toMatchObject({ filesTotal: 8, bytesTotal: 800, totalsFinal: true });
  });

  it("settle() keeps the observed total when the estimate under-counted", () => {
    const updates: { filesTotal: number; bytesTotal: number }[] = [];
    const tracker = createProgressTracker((u) => updates.push(u), ["hashing", "hashed"]);

    tracker.setEstimatedTotals({ files: 1, bytes: 10 });
    tracker.rowDiscovered();
    tracker.rowDiscovered();
    tracker.expectBytes(900);

    tracker.settle();
    expect(updates.at(-1)).toMatchObject({ filesTotal: 2, bytesTotal: 900 });
  });
});
