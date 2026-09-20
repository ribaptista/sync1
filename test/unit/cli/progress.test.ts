import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import prettyBytes from "pretty-bytes";
import { MultiBar } from "cli-progress";

const createLoggerMock = vi.fn((verbose: boolean, destination?: unknown) => ({
  verbose,
  destination,
  debug: vi.fn(),
}));

vi.mock("../../../src/logger.js", () => ({
  createLogger: createLoggerMock,
}));

// startBytesProgressSession's real implementation renders to a real
// cli-progress MultiBar, which would spam actual ANSI output in a test
// run -- mocked here so its `.update()`/`.setTotal()` calls can be
// observed directly instead. These two see every bar's calls, in order --
// use `createdBars` below when a test needs to tell one bar from another.
const barUpdateMock = vi.fn();
const barSetTotalMock = vi.fn();
// Every bar the session creates, in creation order, each with its *own*
// update/setTotal spies -- needed since `sync` now mints one bar per phase
// and the point of several of the tests below is that those bars don't
// share state. The shared barUpdateMock/barSetTotalMock above still see
// every call, in order, so the single-bar tests that predate this are
// unaffected.
const createdBars: Array<{ update: ReturnType<typeof vi.fn>; setTotal: ReturnType<typeof vi.fn> }> =
  [];
const multibarCreateMock = vi.fn((..._createArgs: unknown[]) => {
  const bar = {
    update: vi.fn((...args: unknown[]) => barUpdateMock(...args)),
    setTotal: vi.fn((...args: unknown[]) => barSetTotalMock(...args)),
    getTotal: vi.fn(() => 1),
  };
  createdBars.push(bar);
  return bar;
});
const multibarStopMock = vi.fn();
const multibarRemoveMock = vi.fn();

vi.mock("cli-progress", () => ({
  MultiBar: vi.fn().mockImplementation(() => ({
    create: multibarCreateMock,
    stop: multibarStopMock,
    remove: multibarRemoveMock,
  })),
  Presets: { shades_classic: {} },
}));

const { shouldShowProgress, createLoggerForRun, fitPath, reporterFor } =
  await import("../../../src/cli/progress.js");

describe("shouldShowProgress", () => {
  const originalIsTTY = process.stderr.isTTY;
  afterEach(() => {
    Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
  });

  it("is false when --json is set, even on a real TTY", () => {
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    expect(shouldShowProgress({ json: true, progress: true })).toBe(false);
  });

  it("is false when --no-progress is set, even on a real TTY", () => {
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    expect(shouldShowProgress({ json: false, progress: false })).toBe(false);
  });

  it("is false when stderr isn't a TTY", () => {
    Object.defineProperty(process.stderr, "isTTY", { value: undefined, configurable: true });
    expect(shouldShowProgress({ json: false, progress: true })).toBe(false);
  });

  it("is true only when stderr is a real TTY and neither flag suppresses it", () => {
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    expect(shouldShowProgress({ json: false, progress: true })).toBe(true);
  });
});

describe("createLoggerForRun", () => {
  beforeEach(() => {
    createLoggerMock.mockClear();
    vi.restoreAllMocks();
  });

  it("defers to createLogger(verbose) with no destination when progress bars aren't shown", () => {
    createLoggerForRun({ verbose: true, showProgress: false });
    expect(createLoggerMock).toHaveBeenCalledWith(true);
  });

  it("diverts to fd 3 when progress bars are shown and fd 3 is open", () => {
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
      if (fd === 3) return {} as fs.Stats;
      throw Object.assign(new Error("EBADF"), { code: "EBADF" });
    }) as typeof fs.fstatSync);

    createLoggerForRun({ verbose: true, showProgress: true });

    expect(createLoggerMock).toHaveBeenCalledTimes(1);
    const [verbose, destination] = createLoggerMock.mock.calls[0]!;
    expect(verbose).toBe(true);
    expect(destination).toBeDefined();
  });

  it("discards logging when progress bars are shown but fd 3 isn't open, printing a notice once", async () => {
    vi.resetModules();
    vi.spyOn(fs, "fstatSync").mockImplementation(() => {
      throw Object.assign(new Error("EBADF"), { code: "EBADF" });
    });
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const fresh = await import("../../../src/cli/progress.js");
    fresh.createLoggerForRun({ verbose: true, showProgress: true });
    fresh.createLoggerForRun({ verbose: true, showProgress: true });

    expect(createLoggerMock).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ write: expect.any(Function) }),
    );
    const notices = writeSpy.mock.calls.filter(([chunk]) => String(chunk).includes("discarded"));
    expect(notices).toHaveLength(1);
  });
});

describe("startBytesProgressSession", () => {
  // Re-imported fresh (not the file-top static import): an earlier test in
  // this same file calls vi.resetModules(), which invalidates the
  // originally-bound reference -- see createLoggerForRun's "discards
  // logging" test above, which does the same for the same reason.
  let startBytesProgressSession: typeof import("../../../src/cli/progress.js").startBytesProgressSession;

  beforeEach(async () => {
    barUpdateMock.mockClear();
    barSetTotalMock.mockClear();
    multibarCreateMock.mockClear();
    multibarStopMock.mockClear();
    multibarRemoveMock.mockClear();
    createdBars.length = 0;
    // createLoggerForRun's own beforeEach (above) calls vi.restoreAllMocks(),
    // which wipes this mock's .mockImplementation() back to a no-op for the
    // rest of the file -- reinstated here so these tests don't depend on
    // running before that block does.
    vi.mocked(MultiBar).mockImplementation(
      () =>
        ({
          create: multibarCreateMock,
          stop: multibarStopMock,
          remove: multibarRemoveMock,
        }) as unknown as MultiBar,
    );
    ({ startBytesProgressSession } = await import("../../../src/cli/progress.js"));
  });

  it("show:false returns a no-op session that never touches a real bar", () => {
    const session = startBytesProgressSession({ show: false, overallLabel: "x" });
    session.setOverallTotals({ bytes: 100, files: 5 });
    session.setOverallProgress({ bytes: 50, files: 2 });
    session.stop();
    expect(multibarCreateMock).not.toHaveBeenCalled();
  });

  it("a provisional setOverallTotals only grows the bar's total, never shrinks it", () => {
    const session = startBytesProgressSession({ show: true, overallLabel: "x" });
    barSetTotalMock.mockClear(); // clear the constructor's own initial render

    session.setOverallTotals({ bytes: 1000, files: 10 });
    expect(barSetTotalMock).toHaveBeenLastCalledWith(1000);

    session.setOverallTotals({ bytes: 500, files: 5 }); // smaller -- no-op
    expect(barSetTotalMock).toHaveBeenLastCalledWith(1000); // unchanged

    session.setOverallTotals({ bytes: 2000, files: 20 }); // grows
    expect(barSetTotalMock).toHaveBeenLastCalledWith(2000);
  });

  it("a final setOverallTotals sets the total absolutely, including downward", () => {
    // The whole point of `final`: an enumeration pass that over-counted
    // (a file vanished mid-run) has to be able to correct the denominator
    // down, or the bar stalls just short of 100% forever.
    const session = startBytesProgressSession({ show: true, overallLabel: "x" });
    session.setOverallTotals({ bytes: 1000, files: 10 });
    barSetTotalMock.mockClear();

    session.setOverallTotals({ bytes: 800, files: 8, final: true });
    expect(barSetTotalMock).toHaveBeenLastCalledWith(800);
  });

  it("a final total is still clamped to what's already done, never below it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const session = startBytesProgressSession({ show: true, overallLabel: "x" });
      session.setOverallTotals({ bytes: 1000 });
      vi.setSystemTime(Date.now() + 100);
      session.setOverallProgress({ bytes: 900 });
      barSetTotalMock.mockClear();

      // A nonsense final total below `done` would render past 100%.
      session.setOverallTotals({ bytes: 400, final: true });
      expect(barSetTotalMock).toHaveBeenLastCalledWith(900);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the approximate marker once totals are final", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const session = startBytesProgressSession({ show: true, overallLabel: "x" });
      session.setOverallTotals({ bytes: 1000, files: 10 });
      vi.setSystemTime(Date.now() + 100);
      session.setOverallProgress({ bytes: 500, files: 5 });
      expect(barUpdateMock).toHaveBeenLastCalledWith(
        500,
        expect.objectContaining({ sizeTotal: `~${prettyBytes(1000)}`, etaPrefix: "~" }),
      );

      // The provisional->final edge force-flushes: the rendered format
      // itself changes, so it must not wait out the throttle window.
      session.setOverallTotals({ bytes: 1000, files: 10, final: true });
      expect(barUpdateMock).toHaveBeenLastCalledWith(
        500,
        expect.objectContaining({ sizeTotal: prettyBytes(1000), etaPrefix: "" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("setOverallProgress sets an absolute value and updates the payload with pretty-printed sizes", () => {
    // Fake timers, scoped to Date only: every setOverallProgress/Totals call
    // now goes through the flush throttle (see FLUSH_INTERVAL_MS in
    // progress.ts), so proving the *asserted* call actually reaches the bar
    // means clearing that window first -- the throttle itself is a separate
    // describe below.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const session = startBytesProgressSession({ show: true, overallLabel: "x" });
      session.setOverallTotals({ bytes: 2_000_000, files: 10 });
      vi.setSystemTime(Date.now() + 100);
      session.setOverallProgress({ bytes: 1_000_000, files: 5 });

      expect(barUpdateMock).toHaveBeenLastCalledWith(1_000_000, {
        filesDone: "5",
        // "~" because nothing has declared these totals final yet.
        filesTotal: "~10",
        sizeDone: prettyBytes(1_000_000),
        sizeTotal: `~${prettyBytes(2_000_000)}`,
        etaPrefix: "~",
        activity: "", // no activity reported yet
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a partial update leaves the other field's last-known value unchanged", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const session = startBytesProgressSession({ show: true, overallLabel: "x" });
      session.setOverallTotals({ bytes: 1000, files: 10 });
      vi.setSystemTime(Date.now() + 100);
      session.setOverallProgress({ bytes: 500, files: 5 });
      barUpdateMock.mockClear();

      vi.setSystemTime(Date.now() + 100);
      session.setOverallProgress({ bytes: 700 }); // files omitted
      expect(barUpdateMock).toHaveBeenLastCalledWith(700, {
        filesDone: "5", // unchanged from the previous call
        filesTotal: "~10",
        sizeDone: prettyBytes(700),
        sizeTotal: `~${prettyBytes(1000)}`,
        etaPrefix: "~",
        activity: "",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() stops the underlying multibar", () => {
    const session = startBytesProgressSession({ show: true, overallLabel: "x" });
    session.stop();
    expect(multibarStopMock).toHaveBeenCalledTimes(1);
  });

  it("startPhase mints one labelled bar per phase, and the session's own bar stays unborn", () => {
    const session = startBytesProgressSession({ show: true, overallLabel: "syncing" });
    // Nothing yet: a session that will only ever be driven through phases
    // (sync) must not also render an idle "syncing" bar nothing advances.
    expect(multibarCreateMock).not.toHaveBeenCalled();

    session.startPhase("scanning");
    session.startPhase("uploading");
    session.startPhase("downloading");

    expect(multibarCreateMock).toHaveBeenCalledTimes(3);
    const labels = multibarCreateMock.mock.calls.map(
      (call) => (call[3] as { format: string }).format.split(" ")[0],
    );
    expect(labels).toEqual(["scanning", "uploading", "downloading"]);
  });

  it("the session's own bar is created on first direct use, after any phase bars", () => {
    const session = startBytesProgressSession({ show: true, overallLabel: "scanning" });
    session.setOverallTotals({ bytes: 100 });
    expect(multibarCreateMock).toHaveBeenCalledTimes(1);
    // Repeated use reuses it rather than minting another.
    session.setOverallProgress({ bytes: 10 });
    expect(multibarCreateMock).toHaveBeenCalledTimes(1);
  });

  it("phase bars keep entirely separate totals -- no offset arithmetic between them", () => {
    const session = startBytesProgressSession({ show: true, overallLabel: "syncing" });
    const scanning = session.startPhase("scanning");
    const uploading = session.startPhase("uploading");

    // Activity-bearing so each lands immediately rather than waiting out
    // its bar's own flush throttle -- the subject here is the numbers, not
    // the throttle (which has its own tests above).
    const activity = { verb: "working", path: "f" };
    scanning.setOverallTotals({ bytes: 1000, files: 4, final: true });
    scanning.setOverallProgress({ bytes: 1000, files: 4, activity });
    uploading.setOverallTotals({ bytes: 30, files: 1, final: true });
    uploading.setOverallProgress({ bytes: 10, files: 1, activity });

    const [scanBar, uploadBar] = createdBars;
    // The upload bar counts its own 30 bytes from zero -- it knows nothing
    // about the 1000 the scan phase just finished.
    expect(uploadBar!.setTotal).toHaveBeenLastCalledWith(30);
    expect(uploadBar!.update).toHaveBeenLastCalledWith(
      10,
      expect.objectContaining({ filesDone: "1", filesTotal: "1", sizeTotal: prettyBytes(30) }),
    );
    // ...and the finished phase's bar keeps showing its own completed
    // tally, untouched by the phase that came after it.
    expect(scanBar!.setTotal).toHaveBeenLastCalledWith(1000);
    expect(scanBar!.update).toHaveBeenLastCalledWith(
      1000,
      expect.objectContaining({ filesDone: "4", filesTotal: "4", sizeTotal: prettyBytes(1000) }),
    );
  });

  it("stop() flushes every phase bar, not just the last one", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const session = startBytesProgressSession({ show: true, overallLabel: "syncing" });
      const scanning = session.startPhase("scanning");
      const uploading = session.startPhase("uploading");
      // Both bars flushed once on construction; these land inside that
      // window and are throttled away on both.
      scanning.setOverallProgress({ bytes: 7 });
      uploading.setOverallProgress({ bytes: 9 });

      const [scanBar, uploadBar] = createdBars;
      expect(scanBar!.update).toHaveBeenCalledTimes(1);
      expect(uploadBar!.update).toHaveBeenCalledTimes(1);

      session.stop();

      expect(scanBar!.update).toHaveBeenLastCalledWith(7, expect.anything());
      expect(uploadBar!.update).toHaveBeenLastCalledWith(9, expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders whatever caller-supplied verb it's given, with no vocabulary of its own", () => {
    // "frobnicating" isn't a real verb anywhere in this codebase -- the
    // point is that the module doesn't care, it renders exactly what it's
    // handed rather than validating against a known set.
    const session = startBytesProgressSession({ show: true, overallLabel: "x" });
    session.setOverallTotals({ bytes: 100 });
    session.setOverallProgress({
      bytes: 10,
      activity: { verb: "frobnicating", path: "gear.dat" },
    });

    expect(barUpdateMock).toHaveBeenLastCalledWith(
      10,
      expect.objectContaining({ activity: "frobnicating gear.dat..." }),
    );
  });

  it("a later update omitting activity leaves the previously shown label in place", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const session = startBytesProgressSession({ show: true, overallLabel: "x" });
      session.setOverallTotals({ bytes: 100 });
      session.setOverallProgress({ bytes: 10, activity: { verb: "hashing", path: "a.jpg" } });

      // The activity-bearing call above flushed immediately regardless of
      // any window (activity bypasses the throttle) -- only this follow-up
      // plain numeric call needs the clock advanced to actually land.
      vi.setSystemTime(Date.now() + 100);
      session.setOverallProgress({ bytes: 20 }); // activity omitted

      expect(barUpdateMock).toHaveBeenLastCalledWith(
        20,
        expect.objectContaining({ activity: "hashing a.jpg..." }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes once immediately when a bar is born, before any real progress exists", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const session = startBytesProgressSession({ show: true, overallLabel: "x" });
      session.setOverallTotals({ bytes: 100 });
      // One call, not two: the bar's birth flush renders it straight away
      // (carrying zeroes -- nothing has happened yet), and the update that
      // triggered that birth lands inside its own throttle window.
      expect(barUpdateMock).toHaveBeenCalledTimes(1);
      expect(barUpdateMock).toHaveBeenLastCalledWith(0, expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles a burst of numeric-only updates, flushing again only once the interval elapses", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const session = startBytesProgressSession({ show: true, overallLabel: "x" });
      session.setOverallProgress({ bytes: 0 }); // births the bar
      barUpdateMock.mockClear(); // clear the bar's own immediate birth flush

      session.setOverallProgress({ bytes: 10 });
      session.setOverallProgress({ bytes: 20 });
      session.setOverallProgress({ bytes: 30 });
      expect(barUpdateMock).not.toHaveBeenCalled(); // all three landed inside the same window

      vi.setSystemTime(Date.now() + 100);
      session.setOverallProgress({ bytes: 40 });

      // Exactly one new call, once the interval elapses -- and it carries
      // the *latest* state, not the first value the throttle suppressed.
      expect(barUpdateMock).toHaveBeenCalledTimes(1);
      expect(barUpdateMock).toHaveBeenLastCalledWith(
        40,
        expect.objectContaining({ sizeDone: prettyBytes(40) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes immediately when an update carries a new activity, even inside another update's throttle window", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const session = startBytesProgressSession({ show: true, overallLabel: "x" });
      session.setOverallProgress({ bytes: 0 }); // births the bar
      barUpdateMock.mockClear();

      session.setOverallProgress({ bytes: 10 }); // no activity, no clock advance -- throttled away
      expect(barUpdateMock).not.toHaveBeenCalled();

      session.setOverallProgress({ bytes: 10, activity: { verb: "hashing", path: "a.jpg" } });
      expect(barUpdateMock).toHaveBeenCalledTimes(1);
      expect(barUpdateMock).toHaveBeenLastCalledWith(
        10,
        expect.objectContaining({ activity: "hashing a.jpg..." }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() flushes a throttled-away update's true values, not a stale mid-throttle snapshot", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const session = startBytesProgressSession({ show: true, overallLabel: "x" });
      session.setOverallTotals({ bytes: 1000 });
      barUpdateMock.mockClear();

      session.setOverallProgress({ bytes: 999 }); // no clock advance -- throttled away
      expect(barUpdateMock).not.toHaveBeenCalled();

      session.stop();

      expect(barUpdateMock).toHaveBeenLastCalledWith(
        999,
        expect.objectContaining({ sizeDone: prettyBytes(999) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("startProgressSession", () => {
  // Same fresh-import dance as startBytesProgressSession above, for the
  // same vi.resetModules() reason.
  let startProgressSession: typeof import("../../../src/cli/progress.js").startProgressSession;

  beforeEach(async () => {
    barUpdateMock.mockClear();
    barSetTotalMock.mockClear();
    multibarCreateMock.mockClear();
    vi.mocked(MultiBar).mockImplementation(
      () =>
        ({
          create: multibarCreateMock,
          stop: multibarStopMock,
          remove: multibarRemoveMock,
        }) as unknown as MultiBar,
    );
    ({ startProgressSession } = await import("../../../src/cli/progress.js"));
  });

  it("setOverallProgress sets the position outright, unlike advanceOverall's delta", () => {
    const session = startProgressSession({ show: true, overallLabel: "x", overallUnit: "objects" });

    session.advanceOverall(); // delta: 0 -> 1
    expect(barUpdateMock).toHaveBeenLastCalledWith(1, expect.anything());

    // A pool reporting its own running tally out of order: 7 means 7, not
    // "seven more than whatever the bar happened to be showing".
    session.setOverallProgress(7);
    expect(barUpdateMock).toHaveBeenLastCalledWith(7, expect.anything());

    session.advanceOverall(2); // still a delta, now from 7
    expect(barUpdateMock).toHaveBeenLastCalledWith(9, expect.anything());
  });

  it("marks a provisional total with ~ and drops it once the total is final", () => {
    const session = startProgressSession({ show: true, overallLabel: "x", overallUnit: "objects" });

    session.setOverallTotal(10);
    expect(barUpdateMock).toHaveBeenLastCalledWith(0, { totalLabel: "~10" });

    session.setOverallTotal(10, { final: true });
    expect(barUpdateMock).toHaveBeenLastCalledWith(0, { totalLabel: "10" });
  });

  it("a provisional total only grows, but a final one may correct downward", () => {
    const session = startProgressSession({ show: true, overallLabel: "x", overallUnit: "objects" });

    session.setOverallTotal(100);
    session.setOverallTotal(50); // provisional and smaller -- ignored
    expect(barSetTotalMock).toHaveBeenLastCalledWith(100);

    session.setOverallTotal(50, { final: true });
    expect(barSetTotalMock).toHaveBeenLastCalledWith(50);
  });

  it("a final total is clamped to what's already done", () => {
    const session = startProgressSession({ show: true, overallLabel: "x", overallUnit: "objects" });

    session.setOverallTotal(100);
    session.setOverallProgress(80);
    session.setOverallTotal(20, { final: true }); // nonsense -- would render past 100%

    expect(barSetTotalMock).toHaveBeenLastCalledWith(80);
  });
});

describe("fitPath", () => {
  it("returns the path unchanged when it fits exactly within budget", () => {
    // columns=100, verb="hashing" (7 chars) -> budget = 100 - 55 - 7 = 38
    const path = "a".repeat(38);
    expect(fitPath(path, 100, "hashing")).toBe(path);
  });

  it("truncates from the front, keeping the tail, when the path is over budget", () => {
    // Same budget (38) as above, but a path well past it.
    const path = "/very/long/directory/tree/leading/up/to/summer/IMG_0431.jpg";
    const result = fitPath(path, 100, "hashing");

    expect(result.length).toBe(38);
    expect(result.startsWith("…")).toBe(true);
    expect(path.endsWith(result.slice(1))).toBe(true); // the kept suffix really is the path's tail
    expect(result.endsWith("IMG_0431.jpg")).toBe(true);
  });

  it("floors the budget at the truncation mark's own length when columns/verb leave no room", () => {
    // columns=10, verb="downloading" (11 chars) -> raw budget deeply negative
    const result = fitPath("/some/reasonably/long/path.bin", 10, "downloading");
    expect(result).toBe("…");
  });

  it("falls back to 80 columns when columns is undefined, matching cli-progress's own fallback", () => {
    const path = "/very/long/directory/tree/leading/up/to/summer/IMG_0431.jpg";
    expect(fitPath(path, undefined, "hashing")).toBe(fitPath(path, 80, "hashing"));
  });
});

describe("reporterFor", () => {
  it("collapses a ProgressUpdate into the session's setOverallTotals + setOverallProgress calls", () => {
    const session = {
      setOverallTotals: vi.fn(),
      setOverallProgress: vi.fn(),
      stop: vi.fn(),
    };

    const report = reporterFor(session);
    report({
      filesDone: 3,
      filesTotal: 10,
      bytesDone: 300,
      bytesTotal: 1000,
      totalsFinal: false,
      activity: { verb: "uploading", path: "a.jpg" },
    });

    expect(session.setOverallTotals).toHaveBeenCalledWith({
      files: 10,
      bytes: 1000,
      final: false,
    });
    expect(session.setOverallProgress).toHaveBeenCalledWith({
      files: 3,
      bytes: 300,
      activity: { verb: "uploading", path: "a.jpg" },
    });
  });

  it("passes an update with no activity through as undefined, not omitted", () => {
    const session = {
      setOverallTotals: vi.fn(),
      setOverallProgress: vi.fn(),
      stop: vi.fn(),
    };

    reporterFor(session)({
      filesDone: 1,
      filesTotal: 1,
      bytesDone: 0,
      bytesTotal: 0,
      totalsFinal: false,
    });

    expect(session.setOverallProgress).toHaveBeenCalledWith({
      files: 1,
      bytes: 0,
      activity: undefined,
    });
  });
});
