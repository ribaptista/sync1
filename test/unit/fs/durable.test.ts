import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { durableRename, durableRenameWithRetry } from "../../../src/fs/durable.js";

function ebusy(): NodeJS.ErrnoException {
  const err = new Error("resource busy or locked") as NodeJS.ErrnoException;
  err.code = "EBUSY";
  return err;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("durableRename", () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("publishes the temp file's content under the destination name", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-durable-rename-test-"));
    const tempPath = path.join(dir, ".tmp-file");
    const destPath = path.join(dir, "real-file.txt");
    fs.writeFileSync(tempPath, "durable content");

    durableRename(tempPath, destPath);

    expect(fs.readFileSync(destPath, "utf8")).toBe("durable content");
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it("fsyncs the temp file, renames it, then fsyncs the destination directory -- in that order", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-durable-rename-test-"));
    const tempPath = path.join(dir, ".tmp-file");
    const destPath = path.join(dir, "real-file.txt");
    fs.writeFileSync(tempPath, "data");

    const order: string[] = [];
    const realFsyncSync = fs.fsyncSync.bind(fs);
    const realRenameSync = fs.renameSync.bind(fs);
    const realOpenSync = fs.openSync.bind(fs);

    vi.spyOn(fs, "openSync").mockImplementation((p, flags) => {
      if (p === dir) order.push("open-dir");
      return realOpenSync(p, flags);
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      order.push(order.includes("rename") ? "fsync-dir" : "fsync-temp");
      realFsyncSync(fd);
    });
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      order.push("rename");
      realRenameSync(from as string, to as string);
    });

    durableRename(tempPath, destPath);

    expect(order).toEqual(["fsync-temp", "rename", "open-dir", "fsync-dir"]);
  });

  it("never truncates the destination if the temp file's fsync fails", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-durable-rename-test-"));
    const tempPath = path.join(dir, ".tmp-file");
    const destPath = path.join(dir, "real-file.txt");
    fs.writeFileSync(destPath, "original, still good");
    fs.writeFileSync(tempPath, "would-be replacement");

    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    expect(() => durableRename(tempPath, destPath)).toThrow("disk full");

    // The rename never ran -- the destination is untouched, and the temp
    // file is still there for a caller's own cleanup path to remove.
    expect(fs.readFileSync(destPath, "utf8")).toBe("original, still good");
    expect(fs.existsSync(tempPath)).toBe(true);
  });

  it("does not throw when directory fsync is unsupported (e.g. Windows) -- the rename still lands", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-durable-rename-test-"));
    const tempPath = path.join(dir, ".tmp-file");
    const destPath = path.join(dir, "real-file.txt");
    fs.writeFileSync(tempPath, "data");

    const realOpenSync = fs.openSync.bind(fs);
    vi.spyOn(fs, "openSync").mockImplementation((p, flags) => {
      if (p === dir) {
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return realOpenSync(p, flags);
    });

    expect(() => durableRename(tempPath, destPath)).not.toThrow();
    expect(fs.readFileSync(destPath, "utf8")).toBe("data");
  });

  it("does not throw when a directory fd opens but its own fsync is unsupported", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-durable-rename-test-"));
    const tempPath = path.join(dir, ".tmp-file");
    const destPath = path.join(dir, "real-file.txt");
    fs.writeFileSync(tempPath, "data");

    const realFsyncSync = fs.fsyncSync.bind(fs);
    let temFileFsyncDone = false;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (!temFileFsyncDone) {
        temFileFsyncDone = true;
        realFsyncSync(fd);
        return;
      }
      const err = new Error("invalid argument") as NodeJS.ErrnoException;
      err.code = "EINVAL";
      throw err;
    });

    expect(() => durableRename(tempPath, destPath)).not.toThrow();
    expect(fs.readFileSync(destPath, "utf8")).toBe("data");
  });
});

describe("durableRenameWithRetry", () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("publishes the temp file's content under the destination name", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-durable-rename-retry-test-"));
    const tempPath = path.join(dir, ".tmp-file");
    const destPath = path.join(dir, "real-file.txt");
    fs.writeFileSync(tempPath, "mirror content");

    await durableRenameWithRetry(tempPath, destPath);

    expect(fs.readFileSync(destPath, "utf8")).toBe("mirror content");
  });

  it("recovers after a transient EBUSY on the rename itself", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-durable-rename-retry-test-"));
    const tempPath = path.join(dir, ".tmp-file");
    const destPath = path.join(dir, "real-file.txt");
    fs.writeFileSync(tempPath, "mirror content");

    const realRenameSync = fs.renameSync.bind(fs);
    const spy = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce(() => {
        throw ebusy();
      })
      .mockImplementationOnce((from, to) => realRenameSync(from as string, to as string));

    await durableRenameWithRetry(tempPath, destPath);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(destPath, "utf8")).toBe("mirror content");
  });
});
