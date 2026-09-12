import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renameWithRetry, copyFileWithRetry, writeFileWithRetry } from "../../../src/fs/safe-fs.js";

function ebusy(): NodeJS.ErrnoException {
  const err = new Error("resource busy or locked") as NodeJS.ErrnoException;
  err.code = "EBUSY";
  return err;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safe-fs retry wrapper", () => {
  it("renameWithRetry recovers after a transient EBUSY", async () => {
    const spy = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce(() => {
        throw ebusy();
      })
      .mockImplementationOnce(() => undefined);

    await expect(renameWithRetry("/a", "/b")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("copyFileWithRetry recovers after a transient EBUSY", async () => {
    const spy = vi
      .spyOn(fs, "copyFileSync")
      .mockImplementationOnce(() => {
        throw ebusy();
      })
      .mockImplementationOnce(() => undefined);

    await expect(copyFileWithRetry("/a", "/b")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("writeFileWithRetry recovers after a transient EBUSY", async () => {
    const spy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementationOnce(() => {
        throw ebusy();
      })
      .mockImplementationOnce(() => undefined);

    await expect(writeFileWithRetry("/a", Buffer.from("x"))).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("gives up and rethrows after repeated failures", async () => {
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw ebusy();
    });

    await expect(renameWithRetry("/a", "/b")).rejects.toMatchObject({ code: "EBUSY" });
    expect(spy).toHaveBeenCalledTimes(5); // MAX_ATTEMPTS
  });

  it("does not retry a non-retryable error", async () => {
    const notFound = new Error("no such file") as NodeJS.ErrnoException;
    notFound.code = "ENOENT";
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw notFound;
    });

    await expect(renameWithRetry("/a", "/b")).rejects.toMatchObject({ code: "ENOENT" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("actually performs the operation for real files (not just mocked)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-safe-fs-test-"));
    const src = path.join(dir, "src.txt");
    const dest = path.join(dir, "dest.txt");
    fs.writeFileSync(src, "hello");

    await renameWithRetry(src, dest);
    expect(fs.readFileSync(dest, "utf8")).toBe("hello");
    expect(fs.existsSync(src)).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
