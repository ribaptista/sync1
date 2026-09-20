import { describe, it, expect } from "vitest";
import { runCli, classifyCliOutcome } from "./helpers/cli.js";

/**
 * Tests the test helper, which is worth doing precisely because every other
 * e2e file's assertions are built on it. No LocalStack, no vault -- these
 * only cover how a child process's outcome gets reported.
 */
describe("runCli: a numeric exit code is data, anything else is an error", () => {
  it("reports a clean run as exit 0", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sync1");
  });

  it("passes a real non-zero exit code through as data, not as a throw", async () => {
    // The command runs, decides it can't proceed, and exits with a code the
    // suite legitimately asserts on. This must keep working -- the point of
    // the change is to narrow what counts as an exit code, not to make
    // failures unassertable.
    const result = await runCli(["update_cache", "--root", "/nonexistent-root", "--json"]);
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stdout).toContain('"ok"');
  });
});

describe("classifyCliOutcome", () => {
  const args = ["thumbnail_policy", "create", "--json"];

  it("returns the exit code for a child that ran and exited non-zero", () => {
    const error = Object.assign(new Error("Command failed"), { code: 1 });
    expect(classifyCliOutcome(args, error, "out", "err")).toEqual({
      exitCode: 1,
      stdout: "out",
      stderr: "err",
    });
  });

  it("throws for a signal kill instead of reporting it as exit 1", () => {
    // The regression this guards: SIGABRT from the better-sqlite3 teardown
    // bug (docs/platform-setup.md) arrives with `code` undefined and `signal`
    // set. Reported as 1 it is indistinguishable from EXIT_GENERIC_ERROR --
    // which reads as a real assertion failure on a success path, and silently
    // satisfies `expect(exitCode).not.toBe(0)` on a failure path.
    const error = Object.assign(new Error("Command failed"), {
      code: undefined,
      signal: "SIGABRT" as NodeJS.Signals,
    });
    expect(() => classifyCliOutcome(args, error, "", "")).toThrow(/killed by SIGABRT/);
  });

  it("throws for a spawn failure, whose code is a string rather than a number", () => {
    const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    expect(() => classifyCliOutcome(args, error, "", "")).toThrow(/failed to run \(ENOENT\)/);
  });

  it("throws for a maxBuffer overflow, which also kills the child and truncates output", () => {
    const error = Object.assign(new Error("stdout maxBuffer length exceeded"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    });
    expect(() => classifyCliOutcome(args, error, "", "")).toThrow(
      /ERR_CHILD_PROCESS_STDIO_MAXBUFFER/,
    );
  });

  it("names the command and shows both streams, so a failure is attributable", () => {
    // A suite that spawns hundreds of processes needs the message to say
    // which one died, and what it managed to print first.
    const error = Object.assign(new Error("Command failed"), {
      signal: "SIGKILL" as NodeJS.Signals,
    });
    expect(() => classifyCliOutcome(args, error, "partial stdout", "the real cause")).toThrow(
      /thumbnail_policy create --json killed by SIGKILL[\s\S]*partial stdout[\s\S]*the real cause/,
    );
  });

  it("says so explicitly when a killed child printed nothing at all", () => {
    const error = Object.assign(new Error("Command failed"), {
      signal: "SIGABRT" as NodeJS.Signals,
    });
    // Empty output is the *usual* case for an abort, and a bare "stdout:"
    // would read like the message itself was truncated.
    expect(() => classifyCliOutcome(args, error, "", "")).toThrow(/stdout: \(empty\)/);
  });
});
