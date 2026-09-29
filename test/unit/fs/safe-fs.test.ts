import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renameWithRetry, writeFileAtomic, copyFileAtomic } from "../../../src/fs/safe-fs.js";

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

describe("writeFileAtomic / copyFileAtomic", () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writeFileAtomic publishes the data under the destination name", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-atomic-write-test-"));
    const dest = path.join(dir, "state.db");

    await writeFileAtomic(dest, Buffer.from("hello world"));

    expect(fs.readFileSync(dest, "utf8")).toBe("hello world");
  });

  it("writeFileAtomic overwrites an existing destination in one atomic step, leaving no temp file behind", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-atomic-write-test-"));
    const dest = path.join(dir, "state.db");
    fs.writeFileSync(dest, "old content");

    await writeFileAtomic(dest, Buffer.from("new content"));

    expect(fs.readFileSync(dest, "utf8")).toBe("new content");
    // Nothing but the destination itself should remain in the directory --
    // no leftover `.atomic-write-<hex>` temp sibling.
    expect(fs.readdirSync(dir)).toEqual(["state.db"]);
  });

  it("writeFileAtomic never truncates the destination if the write itself fails", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-atomic-write-test-"));
    const dest = path.join(dir, "state.db");
    fs.writeFileSync(dest, "original, still good");

    vi.spyOn(fs, "writeSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    await expect(writeFileAtomic(dest, Buffer.from("new content"))).rejects.toThrow("disk full");

    // The destination was never touched -- only ever the (now-discarded) temp file was.
    expect(fs.readFileSync(dest, "utf8")).toBe("original, still good");
  });

  it("writeFileAtomic fsyncs the temp file before renaming it into place", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-atomic-write-test-"));
    const dest = path.join(dir, "state.db");
    const order: string[] = [];

    vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      order.push("fsync");
    });
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      order.push("rename");
      // Delegate to the real implementation so the file actually lands.
      vi.mocked(fs.renameSync).mockRestore();
      fs.renameSync(from as string, to as string);
    });

    await writeFileAtomic(dest, Buffer.from("data"));

    expect(order).toEqual(["fsync", "rename"]);
  });

  it("copyFileAtomic publishes the source file's bytes under the destination name", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-atomic-copy-test-"));
    const src = path.join(dir, "candidate.db");
    const dest = path.join(dir, "state.db");
    fs.writeFileSync(src, "candidate bytes");

    await copyFileAtomic(src, dest);

    expect(fs.readFileSync(dest, "utf8")).toBe("candidate bytes");
    // The source is left in place -- only ever copied, never moved.
    expect(fs.readFileSync(src, "utf8")).toBe("candidate bytes");
  });
});
