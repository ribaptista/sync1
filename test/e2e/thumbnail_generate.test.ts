import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realMediaProber } from "../../src/media/probe.js";
import {
  computeContainFitSize,
  realThumbnailGenerator,
} from "../../src/media/thumbnail-generate.js";

const FIXTURES_DIR = path.resolve("test/fixtures/media");
const tempDirs: string[] = [];

function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-thumbnail-generate-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("generateImageThumbnail (real convert)", () => {
  it("generates a normal contain-fit JPEG thumbnail matching the requested dimensions and quality", async () => {
    // tiny.jpg is 32x24 (landscape, ratio 1.333) -- a 20x20 box is not
    // extreme (1.333 <= 2*1), so this exercises the ordinary contain-fit
    // path end to end.
    const size = computeContainFitSize({ width: 32, height: 24 }, { width: 20, height: 20 });
    expect(size).toEqual({ width: 20, height: 15 });

    const destPath = path.join(mkTempDir(), "thumb.jpg");
    await realThumbnailGenerator.generateImageThumbnail({
      sourcePath: path.join(FIXTURES_DIR, "tiny.jpg"),
      destPath,
      width: size.width,
      height: size.height,
      jpegQuality: 80,
    });

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toEqual({ kind: "image", mimeType: "image/jpeg", width: 20, height: 15 });
  });

  it("generates a PNG thumbnail (format matches the original, no -quality flag)", async () => {
    const size = computeContainFitSize({ width: 32, height: 24 }, { width: 16, height: 16 });
    const destPath = path.join(mkTempDir(), "thumb.png");
    await realThumbnailGenerator.generateImageThumbnail({
      sourcePath: path.join(FIXTURES_DIR, "tiny.png"),
      destPath,
      width: size.width,
      height: size.height,
      jpegQuality: 80,
    });

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toMatchObject({ kind: "image", mimeType: "image/png" });
  });

  it("generates an extreme-aspect-ratio thumbnail without distorting or cropping", async () => {
    // computeContainFitSize's own extreme-ratio override is exhaustively
    // unit-tested in thumbnail-generate.test.ts; this only proves
    // generateImageThumbnail faithfully honors whatever exact dimensions
    // it's given via `-resize "WxH!"`, however extreme the resulting box
    // (a source far more elongated than the box, overflowing its long
    // bound rather than being squeezed or cropped).
    const extremeSize = computeContainFitSize(
      { width: 100, height: 10 },
      { width: 20, height: 20 },
    );
    expect(extremeSize).toEqual({ width: 200, height: 20 }); // overflowed the 20-wide box, as designed

    const destPath = path.join(mkTempDir(), "thumb.jpg");
    await realThumbnailGenerator.generateImageThumbnail({
      sourcePath: path.join(FIXTURES_DIR, "tiny.jpg"),
      destPath,
      width: extremeSize.width,
      height: extremeSize.height,
      jpegQuality: 80,
    });

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toEqual({
      kind: "image",
      mimeType: "image/jpeg",
      width: extremeSize.width,
      height: extremeSize.height,
    });
  });
});

describe("generateVideoMosaic (real ffmpeg)", () => {
  it("generates a mosaic JPEG sized exactly rows*tileWidth by columns*tileHeight", async () => {
    const destPath = path.join(mkTempDir(), "mosaic.jpg");
    await realThumbnailGenerator.generateVideoMosaic({
      sourcePath: path.join(FIXTURES_DIR, "tiny.mp4"),
      destPath,
      sourceWidth: 32,
      sourceHeight: 24,
      durationSeconds: 2,
      tileRowCount: 2,
      tileColumnCount: 2,
      tileWidth: 16,
      tileHeight: 12,
      jpegQuality: 80,
    });

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toEqual({ kind: "image", mimeType: "image/jpeg", width: 32, height: 24 });
  });

  it("cleans up its temp frame directory even after generating successfully", async () => {
    const destPath = path.join(mkTempDir(), "mosaic.jpg");
    const tmpEntriesBefore = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("sync1-mosaic-"));

    await realThumbnailGenerator.generateVideoMosaic({
      sourcePath: path.join(FIXTURES_DIR, "tiny.mp4"),
      destPath,
      sourceWidth: 32,
      sourceHeight: 24,
      durationSeconds: 2,
      tileRowCount: 1,
      tileColumnCount: 3,
      tileWidth: 10,
      tileHeight: 10,
      jpegQuality: 50,
    });

    const tmpEntriesAfter = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("sync1-mosaic-"));
    expect(tmpEntriesAfter.length).toBe(tmpEntriesBefore.length);

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toEqual({ kind: "image", mimeType: "image/jpeg", width: 30, height: 10 });
  });
});
