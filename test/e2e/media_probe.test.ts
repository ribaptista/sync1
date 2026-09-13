import { describe, it, expect } from "vitest";
import path from "node:path";
import { realMediaProber } from "../../src/media/probe.js";

const FIXTURES_DIR = path.resolve("test/fixtures/media");

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

  it("returns undefined (not an error) for a non-media file", async () => {
    const result = await realMediaProber.detectMedia(path.join(FIXTURES_DIR, "not-media.txt"));
    expect(result).toBeUndefined();
  });

  it("returns undefined for a nonexistent file rather than throwing", async () => {
    const result = await realMediaProber.detectMedia(path.join(FIXTURES_DIR, "does-not-exist.jpg"));
    expect(result).toBeUndefined();
  });
});
