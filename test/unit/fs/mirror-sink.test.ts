import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  mirrorObjectExists,
  writeMirrorFile,
  writeMirrorStream,
  teeStream,
  withMirrorRetry,
  asMirrorWrite,
  MirrorWriteError,
} from "../../../src/fs/mirror-sink.js";
import { isInTreeTempName } from "../../../src/fs/temp-path.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-mirror-sink-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function errnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

describe("mirrorObjectExists", () => {
  it("is false for a missing file and true only at the expected size", () => {
    const target = path.join(dir, "objects", "ab", "cd", "hash");
    expect(mirrorObjectExists(target, 5)).toBe(false);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "hello");
    expect(mirrorObjectExists(target, 5)).toBe(true);

    // A truncated file is the failure mode this catches for free -- it
    // would otherwise read as "already mirrored" forever, and only a full
    // `mirror verify --checksum` would ever notice.
    fs.writeFileSync(target, "hel");
    expect(mirrorObjectExists(target, 5)).toBe(false);
  });
});

describe("atomic publication", () => {
  it("leaves no partial file at the destination when the write fails", async () => {
    const target = path.join(dir, "objects", "ab", "cd", "hash");
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw errnoError("ENOSPC");
    });

    await expect(writeMirrorFile(target, Buffer.from("payload"))).rejects.toThrow(/ENOSPC/);

    expect(fs.existsSync(target)).toBe(false);
    // And no orphan either: the temp is removed on the failing path, so a
    // full disk doesn't also leave litter behind.
    expect(fs.readdirSync(path.dirname(target))).toEqual([]);
  });

  it("streams through a temp sibling, so the destination only ever appears complete", async () => {
    const target = path.join(dir, "objects", "ab", "cd", "hash");
    const seenDuringWrite: string[] = [];

    const source = new Readable({
      read() {
        // Sampled mid-stream: at this point the bytes are in the temp, and
        // the destination must not exist yet. A plain write-in-place would
        // have a reader seeing a half-written object here.
        seenDuringWrite.push(...safeReaddir(path.dirname(target)));
        this.push(Buffer.from("second half"));
        this.push(null);
      },
    });
    source.push(Buffer.from("first half "));

    await writeMirrorStream(target, source);

    expect(fs.readFileSync(target, "utf8")).toBe("first half second half");
    expect(seenDuringWrite.every((name) => isInTreeTempName(name))).toBe(true);
    expect(seenDuringWrite).not.toContain(path.basename(target));
    expect(fs.readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
  });

  it("removes the temp and publishes nothing when the stream errors partway", async () => {
    const target = path.join(dir, "objects", "ab", "cd", "hash");
    const source = new Readable({
      read() {
        this.destroy(new Error("source gave up"));
      },
    });

    await expect(writeMirrorStream(target, source)).rejects.toThrow(/source gave up/);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(path.dirname(target))).toEqual([]);
  });
});

/**
 * The budget exists to stop a *local* failure driving an unbounded loop.
 * `withS3Retry` has no attempt limit and its retryable errnos include
 * `ETIMEDOUT` and `ENETUNREACH` -- exactly what a dropped SMB mount throws
 * -- so a mirror errno reaching it unwrapped would re-upload to S3 forever
 * because a mount vanished. `MirrorWriteError` carries no errno of its own,
 * which is what keeps the two apart.
 */
describe("withMirrorRetry", () => {
  it("retries a transient mirror failure up to the bound, then gives up", async () => {
    const attempt = vi.fn(async () => {
      throw new MirrorWriteError("/mnt/mirror/x", errnoError("ETIMEDOUT"));
    });

    await expect(withMirrorRetry(attempt)).rejects.toThrow(MirrorWriteError);
    expect(attempt).toHaveBeenCalledTimes(5); // MAX_MIRROR_ATTEMPTS
  });

  it("does not retry a full disk -- no number of attempts un-fills one", async () => {
    const attempt = vi.fn(async () => {
      throw new MirrorWriteError("/mnt/mirror/x", errnoError("ENOSPC"));
    });

    await expect(withMirrorRetry(attempt)).rejects.toThrow(/ENOSPC/);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failure that wasn't the mirror's", async () => {
    // An S3 error reaching here has already exhausted its own unbounded
    // budget; retrying it again on the mirror's would multiply the two.
    const attempt = vi.fn(async () => {
      throw errnoError("ETIMEDOUT");
    });

    await expect(withMirrorRetry(attempt)).rejects.toThrow(/ETIMEDOUT/);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("succeeds on a later attempt without surfacing the earlier failures", async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      if (++calls < 3) throw new MirrorWriteError("/mnt/mirror/x", errnoError("EBUSY"));
      return "done";
    });

    await expect(withMirrorRetry(attempt)).resolves.toBe("done");
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("asMirrorWrite tags a bare errno, and does not re-wrap an already-tagged one", async () => {
    const tagged = await asMirrorWrite("/mnt/mirror/x", async () => {
      throw errnoError("EACCES");
    }).catch((err: unknown) => err);
    expect(tagged).toBeInstanceOf(MirrorWriteError);
    expect((tagged as MirrorWriteError).cause).toMatchObject({ code: "EACCES" });

    const original = new MirrorWriteError("/mnt/mirror/y", errnoError("EBUSY"));
    const passedThrough = await asMirrorWrite("/mnt/mirror/x", async () => {
      throw original;
    }).catch((err: unknown) => err);
    expect(passedThrough).toBe(original);
  });
});

describe("teeStream", () => {
  it("delivers byte-identical output to both branches from a single source", async () => {
    const payload = Buffer.from("a".repeat(100_000) + "b".repeat(100_000));
    const { primary, secondary } = teeStream(Readable.from([payload]));

    const [left, right] = await Promise.all([collect(primary), collect(secondary)]);

    expect(left.equals(payload)).toBe(true);
    expect(right.equals(payload)).toBe(true);
  });

  it("fails both branches when the source fails, so neither sink is left half-written", async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error("source exploded"));
      },
    });
    const { primary, secondary } = teeStream(source);

    await expect(collect(primary)).rejects.toThrow(/source exploded/);
    await expect(collect(secondary)).rejects.toThrow();
  });

  it("fails the other branch when one consumer fails", async () => {
    // The whole read-encrypt-write is one retriable unit, so a mirror that
    // dies must not leave the S3 branch streaming bytes nothing will
    // reconcile -- and vice versa.
    const { primary, secondary } = teeStream(Readable.from([Buffer.from("payload")]));
    primary.destroy(new Error("mirror died"));

    await expect(collect(secondary)).rejects.toThrow();
  });

  /**
   * A source with multiple chunks and a real gap between them, consumed
   * via `collect`'s `for await` -- both are load-bearing. A single-chunk
   * source (as above) never exercises Node's own pipe backpressure at
   * all, since everything is already buffered by the time either
   * destination is touched; a plain event-listener consumer doesn't
   * observe the specific failure mode (a stream that is destroyed but
   * neither ends nor errors reads as a silent hang, not a rejection,
   * under `.on("data"/"end")`, and only `for await`'s async-iterator
   * protocol turns that into `ERR_STREAM_PREMATURE_CLOSE`).
   */
  function multiChunkSource(): Readable {
    return Readable.from(
      (async function* () {
        yield Buffer.from("chunk-1-");
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield Buffer.from("chunk-2-");
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield Buffer.from("chunk-3-");
      })(),
    );
  }

  /** Destroys `secondary` right after its first chunk, mid-stream. */
  function sabotageSecondaryMidStream(secondary: Readable): void {
    let received = 0;
    secondary.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received >= "chunk-1-".length) {
        secondary.destroy(new Error("simulated mid-write mirror failure"));
      }
    });
    secondary.on("error", () => {
      // Consumed here so it never becomes an unhandled rejection; the
      // assertions below read primary, not secondary.
    });
  }

  /**
   * The defect this pins: `Readable` shares ONE flowing/paused state
   * across every `.pipe()` destination it has. When `secondary` backs up
   * or is destroyed mid-write, the *whole source* pauses -- not just the
   * path to `secondary` -- and `source.unpipe(secondary)` alone does not
   * resume it for `primary`. Without an explicit `resume()`, `primary`
   * receives its first chunk and then nothing else, forever: it neither
   * completes nor errors, which is a genuine hang, not a clean detach --
   * for exactly the real-world case (a mount failing partway through a
   * multi-GB transfer) `detach-secondary` exists to survive.
   */
  it("detach-secondary: a mid-stream secondary failure does not stall the primary", async () => {
    const { primary, secondary } = teeStream(multiChunkSource(), "detach-secondary");
    sabotageSecondaryMidStream(secondary);

    const result = await collect(primary);
    expect(result.toString()).toBe("chunk-1-chunk-2-chunk-3-");
  });

  /**
   * The counterpart: `abort-both` must still genuinely abort `primary` for
   * the identical mid-stream failure, not merely for the single-chunk,
   * already-buffered case the older test above covers. Guards against a
   * fix for the hang above accidentally making `abort-both` stop
   * aborting.
   */
  it("abort-both: a mid-stream secondary failure still aborts the primary, not just a single-chunk one", async () => {
    const { primary, secondary } = teeStream(multiChunkSource(), "abort-both");
    sabotageSecondaryMidStream(secondary);

    await expect(collect(primary)).rejects.toThrow();
  });
});

function safeReaddir(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}
