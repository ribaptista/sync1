import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { realMediaProber } from "../../src/media/probe.js";
import { makeAudioTailVideo, cleanupGeneratedMedia } from "./helpers/media.js";

const FIXTURES_DIR = path.resolve("test/fixtures/media");

afterEach(cleanupGeneratedMedia);

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

  it("returns undefined (not an error) for a non-media file", async () => {
    const result = await realMediaProber.detectMedia(path.join(FIXTURES_DIR, "not-media.txt"));
    expect(result).toBeUndefined();
  });

  it("returns undefined for a nonexistent file rather than throwing", async () => {
    const result = await realMediaProber.detectMedia(path.join(FIXTURES_DIR, "does-not-exist.jpg"));
    expect(result).toBeUndefined();
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
