import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

const createLoggerMock = vi.fn((verbose: boolean, destination?: unknown) => ({
  verbose,
  destination,
  debug: vi.fn(),
}));

vi.mock("../../../src/logger.js", () => ({
  createLogger: createLoggerMock,
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
