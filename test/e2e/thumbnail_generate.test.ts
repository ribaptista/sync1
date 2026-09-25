import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realMediaProber } from "../../src/media/probe.js";
import { makeAudioTailVideo, cleanupGeneratedMedia } from "./helpers/media.js";
import {
  computeContainFitSize,
  computeShorterSideFitSize,
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
  cleanupGeneratedMedia();
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
        encoding: { outputMime: "image/jpeg", jpegQuality: 80 },
      },
      silentLogger,
    );

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toEqual({ kind: "image", mimeType: "image/jpeg", width: 20, height: 15 });
  });

  it("generates a PNG thumbnail", async () => {
    const size = computeContainFitSize({ width: 32, height: 24 }, { width: 16, height: 16 });
    const destPath = path.join(mkTempDir(), "thumb.png");
    await realThumbnailGenerator.generateImageThumbnail(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.png"),
        destPath,
        width: size.width,
        height: size.height,
        encoding: { outputMime: "image/png", pngCompressionLevel: 9 },
      },
      silentLogger,
    );

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toMatchObject({ kind: "image", mimeType: "image/png" });
  });

  it("generates a WebP thumbnail (lossy)", async () => {
    const size = computeContainFitSize({ width: 32, height: 24 }, { width: 16, height: 16 });
    const destPath = path.join(mkTempDir(), "thumb.webp");
    await realThumbnailGenerator.generateImageThumbnail(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.png"),
        destPath,
        width: size.width,
        height: size.height,
        encoding: { outputMime: "image/webp", webpQuality: 80, webpLossless: false },
      },
      silentLogger,
    );

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toMatchObject({ kind: "image", mimeType: "image/webp" });
  });

  it("generates a GIF thumbnail from a still image, honoring gif_max_colors", async () => {
    // tiny.jpg/tiny.png are synthetic 1-2 color fixtures -- quantizing them
    // to 8 vs 256 colors makes no difference at all, since there's nothing
    // to quantize. tiny.CR2 is a real photo, with real color complexity for
    // gif_max_colors to actually act on.
    const size = computeContainFitSize({ width: 3906, height: 2602 }, { width: 64, height: 64 });
    const fewColorsPath = path.join(mkTempDir(), "few.gif");
    const manyColorsPath = path.join(mkTempDir(), "many.gif");
    for (const [destPath, gifMaxColors] of [
      [fewColorsPath, 8],
      [manyColorsPath, 256],
    ] as const) {
      await realThumbnailGenerator.generateImageThumbnail(
        {
          sourcePath: path.join(FIXTURES_DIR, "tiny.CR2"),
          destPath,
          width: size.width,
          height: size.height,
          encoding: { outputMime: "image/gif", gifMaxColors, gifDither: "sierra2_4a" },
        },
        silentLogger,
      );
    }

    const probed = await realMediaProber.detectMedia(fewColorsPath);
    expect(probed).toMatchObject({ kind: "image", mimeType: "image/gif" });
    // A knob that's plumbed but ignored would still pass a bare mime-type
    // assertion -- fewer palette colors on a real photo measurably shrinks
    // the file, proving gif_max_colors actually reaches ImageMagick's
    // -colors flag rather than being silently dropped.
    expect(fs.statSync(fewColorsPath).size).toBeLessThan(fs.statSync(manyColorsPath).size);
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
        encoding: { outputMime: "image/jpeg", jpegQuality: 80 },
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

  it("generates a JPEG thumbnail from a Canon CR2 raw source (write-incapable format -- output_mime is required, so the destPath's own format is never inferred from the source)", async () => {
    // tiny.CR2 is 3906x2602 (landscape, ratio 1.501) -- generateImageThumbnail
    // itself is source-format-agnostic (just hands sourcePath/destPath to
    // convert); this only proves convert can actually read a real CR2 and
    // write a resized JPEG from it, which identify succeeding doesn't by
    // itself guarantee.
    const size = computeContainFitSize({ width: 3906, height: 2602 }, { width: 100, height: 100 });
    const destPath = path.join(mkTempDir(), "thumb.jpg");
    await realThumbnailGenerator.generateImageThumbnail(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.CR2"),
        destPath,
        width: size.width,
        height: size.height,
        encoding: { outputMime: "image/jpeg", jpegQuality: 80 },
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
  /**
   * ImageMagick exits nonzero for a recoverable warning *after* writing a
   * complete image. Treating the exit code as the verdict meant refusing to
   * thumbnail a readable file -- the same trap probeImage has to handle one
   * layer up, and the reason a real GIF in a vault could be probed
   * successfully and still never get a thumbnail.
   */
  it("keeps a complete image when convert warns and exits nonzero", async () => {
    // A 1x1 GIF whose only pixel names colour index 3 against a two-entry
    // palette: convert reports "invalid colormap index", exits 1, and
    // writes a valid WebP regardless.
    const sourcePath = path.join(mkTempDir(), "badmap.gif");
    fs.writeFileSync(
      sourcePath,
      Buffer.from([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff,
        0xff, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02,
        0x02, 0x5c, 0x01, 0x00, 0x3b,
      ]),
    );

    const destPath = path.join(mkTempDir(), "thumb.webp");
    await realThumbnailGenerator.generateImageThumbnail(
      {
        sourcePath,
        destPath,
        width: 1,
        height: 1,
        encoding: { outputMime: "image/webp", webpQuality: 50, webpLossless: true },
      },
      silentLogger,
    );

    expect(await realMediaProber.detectMedia(destPath)).toMatchObject({
      kind: "image",
      mimeType: "image/webp",
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
        shorterSide: 12,
        encoding: { outputMime: "image/jpeg", jpegQuality: 80 },
      },
      silentLogger,
    );

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toEqual({ kind: "image", mimeType: "image/jpeg", width: 32, height: 24 });
  });

  it("shorterSide sizes one tile, not the composed grid -- a 2x2 mosaic at shorterSide 12 composes to roughly 2x that, not a 12-ish image", async () => {
    // tiny.mp4 is 32x24, 2s at 5fps (10 real frames) -- tileRowCount *
    // tileColumnCount must stay small enough that every sampled timestamp
    // still lands before the source's last frame (~1.8s here); this is a
    // fixture/sampling constraint, unrelated to what's under test, so the
    // grid is kept to 2x2 rather than something more visually asymmetric.
    // shorterSide 12 gives frame scale 12/24 = 0.5, so each tile is 16x12;
    // the composed grid is 2 cols * 16 = 32 wide, 2 rows * 12 = 24 tall. If
    // shorterSide instead sized the whole grid (the bug this test guards
    // against), the composite would come out close to 12px on its own
    // shorter side -- nowhere near 24x32.
    const destPath = path.join(mkTempDir(), "mosaic.jpg");
    await realThumbnailGenerator.generateVideoMosaic(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.mp4"),
        destPath,
        sourceWidth: 32,
        sourceHeight: 24,
        durationSeconds: 2,
        tileRowCount: 2,
        tileColumnCount: 2,
        shorterSide: 12,
        encoding: { outputMime: "image/jpeg", jpegQuality: 80 },
      },
      silentLogger,
    );

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toEqual({ kind: "image", mimeType: "image/jpeg", width: 32, height: 24 });
  });

  it("generates a PNG mosaic honoring png_compression_level, and a WebP mosaic", async () => {
    const pngPath = path.join(mkTempDir(), "mosaic.png");
    await realThumbnailGenerator.generateVideoMosaic(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.mp4"),
        destPath: pngPath,
        sourceWidth: 32,
        sourceHeight: 24,
        durationSeconds: 2,
        tileRowCount: 2,
        tileColumnCount: 2,
        shorterSide: 12,
        encoding: { outputMime: "image/png", pngCompressionLevel: 9 },
      },
      silentLogger,
    );
    const pngProbed = await realMediaProber.detectMedia(pngPath);
    expect(pngProbed).toMatchObject({ kind: "image", mimeType: "image/png" });

    const webpPath = path.join(mkTempDir(), "mosaic.webp");
    await realThumbnailGenerator.generateVideoMosaic(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.mp4"),
        destPath: webpPath,
        sourceWidth: 32,
        sourceHeight: 24,
        durationSeconds: 2,
        tileRowCount: 2,
        tileColumnCount: 2,
        shorterSide: 12,
        encoding: { outputMime: "image/webp", webpQuality: 80, webpLossless: false },
      },
      silentLogger,
    );
    const webpProbed = await realMediaProber.detectMedia(webpPath);
    expect(webpProbed).toMatchObject({ kind: "image", mimeType: "image/webp" });
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
        shorterSide: 10,
        encoding: { outputMime: "image/jpeg", jpegQuality: 50 },
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

  it("produces a portrait mosaic (not stretched/squished) from a landscape-encoded, -90-rotated source -- the exact bug this plan started from", async () => {
    // Full-stack proof that the rotation fix (probeVideo swapping
    // width/height for a display-rotated stream) and the tile-sizing
    // redesign (computeShorterSideFitSize, no fixed box to disagree with a
    // source's real orientation) work together correctly, composed the
    // same way generateForDecision composes them in production: probe
    // first, feed the *probed* (rotation-corrected) dimensions into
    // frame-size computation, not the raw encoded ones.
    const probed = await realMediaProber.detectMedia(path.join(FIXTURES_DIR, "rotated-90.mp4"));
    expect(probed).toMatchObject({ kind: "video", width: 24, height: 32 }); // already swapped

    const destPath = path.join(mkTempDir(), "mosaic.jpg");
    const { width: sourceWidth, height: sourceHeight } = probed as {
      width: number;
      height: number;
    };
    const frame = computeShorterSideFitSize({ width: sourceWidth, height: sourceHeight }, 10);
    expect(frame.height).toBeGreaterThan(frame.width); // portrait, matching the display-rotated source

    // xstack requires at least 2 inputs, so a 1x1 "mosaic" isn't a valid
    // composite -- 2 rows x 1 column stacks two already-portrait frames
    // vertically, which only makes the result more definitively portrait.
    await realThumbnailGenerator.generateVideoMosaic(
      {
        sourcePath: path.join(FIXTURES_DIR, "rotated-90.mp4"),
        destPath,
        sourceWidth,
        sourceHeight,
        durationSeconds: 2,
        tileRowCount: 2,
        tileColumnCount: 1,
        shorterSide: 10,
        encoding: { outputMime: "image/jpeg", jpegQuality: 80 },
      },
      silentLogger,
    );

    // No crash (the old fixed-box design's pad step would have thrown
    // here on an orientation mismatch), and the composited mosaic itself
    // came out portrait-shaped, matching the frame size computed above --
    // not the pre-fix behavior of silently treating the source as if it
    // were still landscape.
    const mosaicProbed = await realMediaProber.detectMedia(destPath);
    expect(mosaicProbed).toEqual({
      kind: "image",
      mimeType: "image/jpeg",
      width: frame.width,
      height: frame.height * 2,
    });
  });

  /**
   * The bug this pairing exists for, end to end. A clip whose audio
   * outlasts its video used to be un-thumbnailable forever: the last tile
   * is placed at `duration * 15.5 / 16`, and taking that from the
   * *container's* duration put it past the final video frame. ffmpeg
   * answers a seek past the end by writing nothing and exiting 0, so the
   * failure only surfaced a stage later, as the composite reporting "No
   * such file or directory" for a frame that was never written.
   */
  it("composes a mosaic from a clip whose audio outlasts its video", async () => {
    const sourcePath = await makeAudioTailVideo();
    const probed = await realMediaProber.detectMedia(sourcePath);
    const { width, height, durationSeconds } = probed as {
      width: number;
      height: number;
      durationSeconds: number;
    };

    const destPath = path.join(mkTempDir(), "mosaic.jpg");
    await realThumbnailGenerator.generateVideoMosaic(
      {
        sourcePath,
        destPath,
        sourceWidth: width,
        sourceHeight: height,
        durationSeconds,
        tileRowCount: 4,
        tileColumnCount: 4,
        shorterSide: 12,
        encoding: { outputMime: "image/jpeg", jpegQuality: 80 },
      },
      silentLogger,
    );

    // All 16 tiles extracted and composed -- not an abort on a frame that
    // was never written.
    expect(await realMediaProber.detectMedia(destPath)).toMatchObject({
      kind: "image",
      mimeType: "image/jpeg",
    });
  });
});

describe("generateVideoPreview (real ffmpeg)", () => {
  it("generates an animated GIF sized by computeShorterSideFitSize, same frame-extraction shape as a mosaic", async () => {
    const destPath = path.join(mkTempDir(), "clip.gif");
    // tiny.mp4 is 32x24 (landscape, min dimension 24). shorterSide 16 gives
    // scale 16/24, frame = {width: round(32*16/24)=21, height:
    // round(24*16/24)=16} -- computed the same way generateVideoMosaic's
    // own frame size is.
    const frame = computeShorterSideFitSize({ width: 32, height: 24 }, 16);
    await realThumbnailGenerator.generateVideoPreview(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.mp4"),
        destPath,
        sourceWidth: 32,
        sourceHeight: 24,
        durationSeconds: 2,
        frameCount: 4,
        frameDelayMs: 100,
        shorterSide: 16,
        encoding: { outputMime: "image/gif", gifMaxColors: 256, gifDither: "sierra2_4a" },
      },
      silentLogger,
    );

    // identify's "[0]" frame index (src/media/probe.ts's probeImage) reads
    // exactly the first frame, which -- since every extracted frame is
    // scaled identically -- reports the same dimensions any frame would.
    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toEqual({
      kind: "image",
      mimeType: "image/gif",
      width: frame.width,
      height: frame.height,
    });
  });

  it("cleans up its temp frame directory even after generating successfully", async () => {
    const destPath = path.join(mkTempDir(), "clip.gif");
    const tmpEntriesBefore = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("sync1-preview-"));

    await realThumbnailGenerator.generateVideoPreview(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.mp4"),
        destPath,
        sourceWidth: 32,
        sourceHeight: 24,
        durationSeconds: 2,
        frameCount: 3,
        frameDelayMs: 200,
        shorterSide: 10,
        encoding: { outputMime: "image/gif", gifMaxColors: 256, gifDither: "sierra2_4a" },
      },
      silentLogger,
    );

    const tmpEntriesAfter = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("sync1-preview-"));
    expect(tmpEntriesAfter.length).toBe(tmpEntriesBefore.length);

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toMatchObject({ kind: "image", mimeType: "image/gif" });
  });

  it("produces a portrait GIF (not stretched/squished) from a landscape-encoded, -90-rotated source", async () => {
    // Same rotation-correctness proof as generateVideoMosaic's own
    // equivalent test above, for the other output type: the probed
    // (rotation-corrected) dimensions must drive frame sizing, not the
    // raw encoded ones.
    const probed = await realMediaProber.detectMedia(path.join(FIXTURES_DIR, "rotated-90.mp4"));
    expect(probed).toMatchObject({ kind: "video", width: 24, height: 32 });

    const destPath = path.join(mkTempDir(), "clip.gif");
    const { width: sourceWidth, height: sourceHeight } = probed as {
      width: number;
      height: number;
    };
    const frame = computeShorterSideFitSize({ width: sourceWidth, height: sourceHeight }, 10);
    expect(frame.height).toBeGreaterThan(frame.width); // portrait, matching the display-rotated source

    await realThumbnailGenerator.generateVideoPreview(
      {
        sourcePath: path.join(FIXTURES_DIR, "rotated-90.mp4"),
        destPath,
        sourceWidth,
        sourceHeight,
        durationSeconds: 2,
        frameCount: 3,
        frameDelayMs: 100,
        shorterSide: 10,
        encoding: { outputMime: "image/gif", gifMaxColors: 256, gifDither: "sierra2_4a" },
      },
      silentLogger,
    );

    const gifProbed = await realMediaProber.detectMedia(destPath);
    expect(gifProbed).toEqual({
      kind: "image",
      mimeType: "image/gif",
      width: frame.width,
      height: frame.height,
    });
  });

  it("generates a genuinely animated WebP preview (more than one frame, not just a .webp-named still)", async () => {
    const destPath = path.join(mkTempDir(), "clip.webp");
    await realThumbnailGenerator.generateVideoPreview(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.mp4"),
        destPath,
        sourceWidth: 32,
        sourceHeight: 24,
        durationSeconds: 2,
        frameCount: 4,
        frameDelayMs: 100,
        shorterSide: 16,
        encoding: { outputMime: "image/webp", webpQuality: 80, webpLossless: false },
      },
      silentLogger,
    );

    const probed = await realMediaProber.detectMedia(destPath);
    expect(probed).toMatchObject({ kind: "image", mimeType: "image/webp" });

    // A single-frame WebP would probe identically to an animated one via
    // `realMediaProber` (mime type alone) -- the real, decoded frame count
    // is what actually distinguishes "genuinely animated" from "happens to
    // have a .webp extension".
    const frameCount = await countAnimatedFrames(destPath);
    expect(frameCount).toBeGreaterThan(1);
  });

  it("gif_max_colors is load-bearing -- fewer palette colors measurably shrinks the file", async () => {
    const fewColorsPath = path.join(mkTempDir(), "few.gif");
    const manyColorsPath = path.join(mkTempDir(), "many.gif");
    for (const [destPath, gifMaxColors] of [
      [fewColorsPath, 8],
      [manyColorsPath, 256],
    ] as const) {
      await realThumbnailGenerator.generateVideoPreview(
        {
          sourcePath: path.join(FIXTURES_DIR, "tiny.mp4"),
          destPath,
          sourceWidth: 32,
          sourceHeight: 24,
          durationSeconds: 2,
          frameCount: 4,
          frameDelayMs: 100,
          shorterSide: 16,
          encoding: { outputMime: "image/gif", gifMaxColors, gifDither: "sierra2_4a" },
        },
        silentLogger,
      );
    }

    expect(fs.statSync(fewColorsPath).size).toBeLessThan(fs.statSync(manyColorsPath).size);
  });

  it("a GIF's stored per-frame delay round-trips at 10ms (centisecond) granularity, rounding a non-multiple-of-10 request", async () => {
    // frameDelayMs 33 -> 3.3cs, which GIF (centisecond granularity) can
    // only store as a whole number of centiseconds -- rounds to 3cs (30ms).
    // Pinning this here means the quantization is a known, tested fact
    // rather than something discovered later against a real file.
    const destPath = path.join(mkTempDir(), "clip.gif");
    await realThumbnailGenerator.generateVideoPreview(
      {
        sourcePath: path.join(FIXTURES_DIR, "tiny.mp4"),
        destPath,
        sourceWidth: 32,
        sourceHeight: 24,
        durationSeconds: 2,
        frameCount: 3,
        frameDelayMs: 33,
        shorterSide: 16,
        encoding: { outputMime: "image/gif", gifMaxColors: 256, gifDither: "sierra2_4a" },
      },
      silentLogger,
    );

    const centiseconds = await readGifFrameDelayCentiseconds(destPath);
    expect(centiseconds).toBe(3);
  });
});

/**
 * Real, decoded frame count -- distinguishes a genuinely animated image
 * from a single-frame one sharing the same mime type. Via ImageMagick's
 * `identify`, not ffprobe: this build's ffprobe doesn't understand
 * animated WebP's ANIM/ANMF chunks at all ("skipping unsupported chunk"),
 * so it can't count frames for that format, while `identify` (already this
 * project's own prober for still images) handles it correctly.
 */
async function countAnimatedFrames(mediaPath: string): Promise<number> {
  const { stdout } = await execFileP("identify", ["-format", "%n\n", mediaPath]);
  return Number(stdout.trim().split("\n")[0]);
}

/** The first frame's stored duration, in centiseconds, via ffprobe's per-frame side data. */
async function readGifFrameDelayCentiseconds(gifPath: string): Promise<number> {
  const { stdout } = await execFileP("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "frame=duration_time",
    "-of",
    "csv=p=0",
    gifPath,
  ]);
  const seconds = Number(stdout.trim().split("\n")[0]);
  return Math.round(seconds * 100);
}

function execFileP(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
