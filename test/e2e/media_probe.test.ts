import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realMediaProber } from "../../src/media/probe.js";
import { makeAudioTailVideo, cleanupGeneratedMedia } from "./helpers/media.js";

const FIXTURES_DIR = path.resolve("test/fixtures/media");

const tempDirs: string[] = [];

afterEach(() => {
  cleanupGeneratedMedia();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("realMediaProber (real identify/ffprobe binaries)", () => {
  it("detects a JPEG's mime type and dimensions", async () => {
    const result = await realMediaProber.detectMedia(path.join(FIXTURES_DIR, "tiny.jpg"));
    expect(result).toEqual({ kind: "image", mimeType: "image/jpeg", width: 32, height: 24 });
  });

  it("detects a PNG's mime type and dimensions", async () => {
    const result = await realMediaProber.detectMedia(path.join(FIXTURES_DIR, "tiny.png"));
    expect(result).toEqual({ kind: "image", mimeType: "image/png", width: 32, height: 24 });
  });

  it("detects an MP4's mime type, dimensions, and duration", async () => {
    const result = await realMediaProber.detectMedia(path.join(FIXTURES_DIR, "tiny.mp4"));
    expect(result).toMatchObject({ kind: "video", mimeType: "video/mp4", width: 32, height: 24 });
    expect((result as { durationSeconds: number }).durationSeconds).toBeCloseTo(2, 0);
  });

  it("detects a Canon CR2 raw file's mime type and dimensions (read-only format, no encoder)", async () => {
    const result = await realMediaProber.detectMedia(path.join(FIXTURES_DIR, "tiny.CR2"));
    expect(result).toEqual({
      kind: "image",
      mimeType: "image/x-canon-cr2",
      width: 3906,
      height: 2602,
    });
  });

  it("swaps width/height for a video with a -90-degree display rotation, unlike its raw stream dimensions", async () => {
    // rotated-90.mp4's raw stream is 32x24 (landscape) with Display Matrix
    // side data declaring rotation: -90 -- generated with -noautorotate
    // before -i specifically so the rotation lands as declared metadata,
    // not baked into the raw pixels (confirmed directly: the same recipe
    // without -noautorotate produces raw dims already swapped to 24x32
    // with no side_data_list at all, which would make this fixture
    // vacuously pass without ever exercising the fix).
    const result = await realMediaProber.detectMedia(path.join(FIXTURES_DIR, "rotated-90.mp4"));
    expect(result).toMatchObject({ kind: "video", mimeType: "video/mp4", width: 24, height: 32 });
  });

  it("does not swap dimensions for a 180-degree display rotation", async () => {
    // Proves 180 is handled as genuinely distinct from the 90-family case
    // above -- side data is present (unlike tiny.mp4, which has none at
    // all), but rotationSwapsDimensions correctly leaves it alone.
    const result = await realMediaProber.detectMedia(path.join(FIXTURES_DIR, "rotated-180.mp4"));
    expect(result).toMatchObject({ kind: "video", mimeType: "video/mp4", width: 32, height: 24 });
  });

  it("reports a non-media file as unreadable, carrying the tools' own reason", async () => {
    const result = await realMediaProber.detectMedia(path.join(FIXTURES_DIR, "not-media.txt"));
    expect(result.kind).toBe("unreadable");
    // The reason is what makes the difference between "14 files failed" and
    // knowing which are corrupt -- it must not be an empty string.
    expect((result as { reason: string }).reason.length).toBeGreaterThan(0);
  });

  it("reports a nonexistent file as unreadable rather than throwing", async () => {
    const result = await realMediaProber.detectMedia(path.join(FIXTURES_DIR, "does-not-exist.jpg"));
    expect(result.kind).toBe("unreadable");
  });

  /**
   * `identify` reports a complete answer *and* exits nonzero over a
   * recoverable warning. Treating the exit code as the verdict meant
   * discarding a perfectly good probe and refusing to thumbnail a readable
   * file -- observed on a real 52x52 GIF with an invalid colormap index.
   */
  it("uses identify's answer when it exits nonzero but printed a usable one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-warned-gif-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "warned.gif");
    // A 1x1 GIF whose single pixel names colour index 3 against a
    // two-entry palette. identify reports `GIF|1|1` on stdout and *still*
    // exits 1 with "invalid colormap index" -- verified against this exact
    // byte sequence, and the same shape as the real file that exposed it.
    fs.writeFileSync(
      filePath,
      Buffer.from([
        0x47,
        0x49,
        0x46,
        0x38,
        0x39,
        0x61, // GIF89a
        0x01,
        0x00,
        0x01,
        0x00, // 1x1
        0x80,
        0x00,
        0x00, // global colour table, 2 entries
        0xff,
        0xff,
        0xff,
        0x00,
        0x00,
        0x00, // white, black
        0x2c,
        0x00,
        0x00,
        0x00,
        0x00,
        0x01,
        0x00,
        0x01,
        0x00,
        0x00, // image descriptor
        0x02, // LZW minimum code size
        0x02,
        0x5c,
        0x01, // CLEAR(4), index 3 -- past the palette -- EOI(5)
        0x00,
        0x3b,
      ]),
    );

    const result = await realMediaProber.detectMedia(filePath);
    expect(result).toMatchObject({ kind: "image", mimeType: "image/gif" });
  });

  /**
   * The container's duration is its *longest* stream's, so an audio tail
   * makes it overstate how far into the file a video frame can still be
   * found. Every frame sampler places its last sample near the end, so
   * taking the container's figure put that sample past the final frame --
   * ffmpeg then wrote nothing and still exited 0, and the thumbnail failed
   * forever with an error naming the compositing step instead.
   */
  it("reports the video stream's own duration, not the container's longer one", async () => {
    const filePath = await makeAudioTailVideo();

    const result = await realMediaProber.detectMedia(filePath);

    expect(result).toMatchObject({ kind: "video", mimeType: "video/mp4" });
    const { durationSeconds } = result as { durationSeconds: number };
    expect(durationSeconds).toBeCloseTo(1, 1); // the video stream
    expect(durationSeconds).toBeLessThan(1.5); // decisively not the 2s container
  });
});
