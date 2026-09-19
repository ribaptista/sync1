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

const silentLogger = {
  debug: () => {},
  warn: () => {},
} as unknown as import("../../src/logger.js").Logger;

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
    await realThumbnailGenerator.generateImageThumbnail(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.jpg"),
        destPath,
        width: size.width,
        height: size.height,
        jpegQuality: 80,
      },
      silentLogger,
    );

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toEqual({ kind: "image", mimeType: "image/jpeg", width: 20, height: 15 });
  });

  it("generates a PNG thumbnail (format matches the original, no -quality flag)", async () => {
    const size = computeContainFitSize({ width: 32, height: 24 }, { width: 16, height: 16 });
    const destPath = path.join(mkTempDir(), "thumb.png");
    await realThumbnailGenerator.generateImageThumbnail(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.png"),
        destPath,
        width: size.width,
        height: size.height,
        jpegQuality: 80,
      },
      silentLogger,
    );

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
    await realThumbnailGenerator.generateImageThumbnail(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.jpg"),
        destPath,
        width: extremeSize.width,
        height: extremeSize.height,
        jpegQuality: 80,
      },
      silentLogger,
    );

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toEqual({
      kind: "image",
      mimeType: "image/jpeg",
      width: extremeSize.width,
      height: extremeSize.height,
    });
  });

  it("generates a JPEG thumbnail from a Canon CR2 raw source (write-incapable format, forced to a JPEG destPath by the caller)", async () => {
    // tiny.CR2 is 3906x2602 (landscape, ratio 1.501) -- generateImageThumbnail
    // itself is source-format-agnostic (just hands sourcePath/destPath to
    // convert); the CR2-forces-.jpg-output decision lives one layer up, in
    // expectedThumbExtension (src/fs/thumbnail.ts) -- this only proves
    // convert can actually read a real CR2 and write a resized JPEG from
    // it, which identify succeeding doesn't by itself guarantee.
    const size = computeContainFitSize({ width: 3906, height: 2602 }, { width: 100, height: 100 });
    const destPath = path.join(mkTempDir(), "thumb.jpg");
    await realThumbnailGenerator.generateImageThumbnail(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.CR2"),
        destPath,
        width: size.width,
        height: size.height,
        jpegQuality: 80,
      },
      silentLogger,
    );

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toEqual({
      kind: "image",
      mimeType: "image/jpeg",
      width: size.width,
      height: size.height,
    });
  });
});

describe("generateVideoMosaic (real ffmpeg)", () => {
  it("generates a mosaic JPEG sized exactly rows*frameHeight by columns*frameWidth", async () => {
    const destPath = path.join(mkTempDir(), "mosaic.jpg");
    // tiny.mp4 is 32x24 (landscape, min dimension 24). tileSize 12 (the old
    // fixture's tileHeight, its box's own short side) reuses the same
    // effective scale the old fixed-box fixture exercised: scale =
    // 12/24 = 0.5, frame = {width: round(32*0.5)=16, height:
    // round(24*0.5)=12} -- identical to the old {tileWidth:16,
    // tileHeight:12} box, so the composited mosaic size is unchanged from
    // before this rename: 2 cols * 16 = 32, 2 rows * 12 = 24.
    await realThumbnailGenerator.generateVideoMosaic(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.mp4"),
        destPath,
        sourceWidth: 32,
        sourceHeight: 24,
        durationSeconds: 2,
        tileRowCount: 2,
        tileColumnCount: 2,
        tileSize: 12,
        jpegQuality: 80,
      },
      silentLogger,
    );

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toEqual({ kind: "image", mimeType: "image/jpeg", width: 32, height: 24 });
  });

  it("cleans up its temp frame directory even after generating successfully", async () => {
    const destPath = path.join(mkTempDir(), "mosaic.jpg");
    const tmpEntriesBefore = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("sync1-mosaic-"));

    // tileSize 10 reuses the old fixture's tileWidth/tileHeight (both 10,
    // a square box) as the single shorter-side target. Source 32x24: min
    // dimension is height (24), scale = 10/24 = 0.41666...  frame.height =
    // round(24*0.41666...) = 10 exactly (the short axis always lands
    // exactly on tileSize); frame.width = round(32*0.41666...) =
    // round(13.333...) = 13. This genuinely changes the composited size
    // from the old fixed-box result: the old {tileWidth:10, tileHeight:10}
    // square box letterboxed (via `pad`) the fit-to-{10,8} frame up to
    // 10x10, giving 3*10=30 wide; the new no-pad scheme has no box to pad
    // into, so the frame keeps its own 13-wide shape and the mosaic comes
    // out 3*13=39 wide, 1*10=10 tall.
    await realThumbnailGenerator.generateVideoMosaic(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.mp4"),
        destPath,
        sourceWidth: 32,
        sourceHeight: 24,
        durationSeconds: 2,
        tileRowCount: 1,
        tileColumnCount: 3,
        tileSize: 10,
        jpegQuality: 50,
      },
      silentLogger,
    );

    const tmpEntriesAfter = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("sync1-mosaic-"));
    expect(tmpEntriesAfter.length).toBe(tmpEntriesBefore.length);

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toEqual({ kind: "image", mimeType: "image/jpeg", width: 39, height: 10 });
  });
});
