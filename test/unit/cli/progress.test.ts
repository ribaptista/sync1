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
// observed directly instead. Shared across bar instances since every test
// below creates at most one session (and therefore one bar) at a time.
const barUpdateMock = vi.fn();
const barSetTotalMock = vi.fn();
const multibarCreateMock = vi.fn(() => ({
  update: barUpdateMock,
  setTotal: barSetTotalMock,
  getTotal: vi.fn(() => 1),
}));
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

const { shouldShowProgress, createLoggerForRun } = await import("../../../src/cli/progress.js");

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

  it("setOverallTotals only grows the bar's total, never shrinks it", () => {
    const session = startBytesProgressSession({ show: true, overallLabel: "x" });
    barSetTotalMock.mockClear(); // clear the constructor's own initial render

    session.setOverallTotals({ bytes: 1000, files: 10 });
    expect(barSetTotalMock).toHaveBeenLastCalledWith(1000);

    session.setOverallTotals({ bytes: 500, files: 5 }); // smaller -- no-op
    expect(barSetTotalMock).toHaveBeenLastCalledWith(1000); // unchanged

    session.setOverallTotals({ bytes: 2000, files: 20 }); // grows
    expect(barSetTotalMock).toHaveBeenLastCalledWith(2000);
  });

  it("setOverallProgress sets an absolute value and updates the payload with pretty-printed sizes", () => {
    const session = startBytesProgressSession({ show: true, overallLabel: "x" });
    session.setOverallTotals({ bytes: 2_000_000, files: 10 });
    session.setOverallProgress({ bytes: 1_000_000, files: 5 });

    expect(barUpdateMock).toHaveBeenLastCalledWith(1_000_000, {
      filesDone: "5",
      filesTotal: "10",
      sizeDone: prettyBytes(1_000_000),
      sizeTotal: prettyBytes(2_000_000),
    });
  });

  it("a partial update leaves the other field's last-known value unchanged", () => {
    const session = startBytesProgressSession({ show: true, overallLabel: "x" });
    session.setOverallTotals({ bytes: 1000, files: 10 });
    session.setOverallProgress({ bytes: 500, files: 5 });
    barUpdateMock.mockClear();

    session.setOverallProgress({ bytes: 700 }); // files omitted
    expect(barUpdateMock).toHaveBeenLastCalledWith(700, {
      filesDone: "5", // unchanged from the previous call
      filesTotal: "10",
      sizeDone: prettyBytes(700),
      sizeTotal: prettyBytes(1000),
    });
  });

  it("stop() stops the underlying multibar", () => {
    const session = startBytesProgressSession({ show: true, overallLabel: "x" });
    session.stop();
    expect(multibarStopMock).toHaveBeenCalledTimes(1);
  });
});
