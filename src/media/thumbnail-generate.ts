import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logger.js";
import { MediaToolMissingError } from "./probe.js";
import type { ThumbnailGifDither } from "../db/repositories/thumbnail-policies-repository.js";

export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Beyond this source-to-box aspect-ratio ratio, standard contain-fit would
 * squeeze the short output dimension to less than half of the box's own
 * short bound -- past that point we'd rather let the long dimension
 * overflow the box than keep shrinking the short one toward zero. Exact
 * derivation: contain-fit's short output dimension is
 * `boxShort * (boxRatio / sourceRatio)` whenever `sourceRatio >= boxRatio`
 * (no degeneracy at all when `sourceRatio <= boxRatio`), so it equals
 * `boxShort / 2` exactly when `sourceRatio == 2 * boxRatio` -- the natural,
 * precisely unit-testable threshold for "lost more than half its value".
 */
const EXTREME_RATIO_MULTIPLIER = 2;

/**
 * Computes the resized dimensions for fitting `source` within `box`,
 * preserving aspect ratio and never distorting -- see the design notes
 * above `EXTREME_RATIO_MULTIPLIER`. Orientation-aware: the box's
 * width/height are swapped internally (`effectiveBox`) so its long axis
 * always aligns with the source's long axis, regardless of how the box's
 * own width/height happen to be configured -- a portrait source always
 * gets a portrait-shaped effective box. In the ordinary case this is a
 * standard "contain" fit; in the extreme-aspect-ratio case (see
 * `EXTREME_RATIO_MULTIPLIER`), the short output side is instead forced to
 * exactly the box's own short bound, and the long side is left to overflow
 * the box's other bound -- never cropped, never distorted.
 */
export function computeContainFitSize(source: Dimensions, box: Dimensions): Dimensions {
  const sourceIsLandscape = source.width >= source.height;
  const boxIsLandscape = box.width >= box.height;
  const effectiveBox: Dimensions =
    sourceIsLandscape === boxIsLandscape ? box : { width: box.height, height: box.width };

  const sourceRatio = Math.max(source.width, source.height) / Math.min(source.width, source.height);
  const boxRatio =
    Math.max(effectiveBox.width, effectiveBox.height) /
    Math.min(effectiveBox.width, effectiveBox.height);

  const scale =
    sourceRatio > EXTREME_RATIO_MULTIPLIER * boxRatio
      ? Math.min(effectiveBox.width, effectiveBox.height) / Math.min(source.width, source.height)
      : Math.min(effectiveBox.width / source.width, effectiveBox.height / source.height);

  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

/**
 * Scales `source` so its own *shorter* side lands exactly on `shortSide` --
 * scale is derived from whichever of `source`'s own dimensions is smaller,
 * and both axes are scaled by that same factor, so the long side falls out
 * of `source`'s own aspect ratio rather than being configured directly.
 * Shared by every non-`fit_to_box` sizing branch: an image's own
 * `resize_shorter_side`, one mosaic tile, or one preview frame (all live in
 * the policy's single `shorterSide` column -- see
 * `docs/architecture/thumbnails.md`). Deliberately has no orientation
 * concept at all (no portrait/landscape branch, unlike
 * `computeContainFitSize` above) -- every frame sampled from one video
 * shares that video's aspect ratio, and an image has only the one aspect
 * ratio to begin with, so there's no "declared box vs. source orientation"
 * pairing left to get wrong, structurally, not by convention.
 */
export function computeShorterSideFitSize(source: Dimensions, shortSide: number): Dimensions {
  const scale = shortSide / Math.min(source.width, source.height);
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

/** Thrown for a per-file generation failure (bad/corrupt source, unsupported output format, etc.) -- non-fatal, caller logs and skips this file. */
export class ThumbnailGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThumbnailGenerationError";
  }
}

function execFileP(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

const SHELL_SAFE_UNQUOTED = /^[a-zA-Z0-9_\-./:=,@]+$/;

/** Single-quotes any arg that isn't trivially shell-safe -- log output only, never fed back to a shell. */
function formatCommandForLog(command: string, args: string[]): string {
  return [command, ...args]
    .map((part) => (SHELL_SAFE_UNQUOTED.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`))
    .join(" ");
}

/**
 * Runs an external tool, mapping a real ENOENT to `MediaToolMissingError`
 * (fatal) and any other nonzero exit to `ThumbnailGenerationError`
 * (per-file, non-fatal). Logs the exact command line at debug level (i.e.
 * visible under `--verbose`) before running it -- lets a user reproduce and
 * inspect a specific generation step by hand, e.g. to compare against a
 * locally-installed ffmpeg's own behavior for an unusual input.
 */
async function runTool(
  command: string,
  args: string[],
  toolLabel: string,
  logger: Logger,
): Promise<void> {
  logger.debug({ command: formatCommandForLog(command, args) }, `running ${toolLabel}`);
  try {
    await execFileP(command, args);
  } catch (err) {
    if (isEnoent(err)) {
      throw new MediaToolMissingError(
        `"${command}" not found on PATH -- required for thumbnail generation`,
      );
    }
    const stderr =
      typeof err === "object" && err !== null ? (err as { stderr?: string }).stderr : undefined;
    const message = err instanceof Error ? err.message : String(err);
    throw new ThumbnailGenerationError(`${toolLabel} failed: ${stderr?.trim() || message}`);
  }
}

/**
 * How a generator's produced pixels are compressed -- shared shape across
 * all three generators, one arm per `output_mime`. Not every arm is legal
 * for every generator (a mosaic is never `image/gif`, a preview is only
 * ever `image/gif`/`image/webp` -- see `thumbnail-policies-repository.ts`'s
 * `LEGAL_OUTPUT_MIMES`), so each generator's own input type `Extract`s the
 * arms it actually accepts rather than accepting the full union.
 */
export type ImageEncoding =
  | { outputMime: "image/jpeg"; jpegQuality: number }
  | { outputMime: "image/png"; pngCompressionLevel: number }
  | { outputMime: "image/webp"; webpQuality: number; webpLossless: boolean }
  | { outputMime: "image/gif"; gifMaxColors: number; gifDither: ThumbnailGifDither };

export type MosaicEncoding = Extract<
  ImageEncoding,
  { outputMime: "image/jpeg" | "image/png" | "image/webp" }
>;
export type PreviewEncoding = Extract<ImageEncoding, { outputMime: "image/gif" | "image/webp" }>;

export interface ThumbnailGenerator {
  generateImageThumbnail(input: GenerateImageThumbnailInput, logger: Logger): Promise<void>;
  generateVideoMosaic(input: GenerateVideoMosaicInput, logger: Logger): Promise<void>;
  generateVideoPreview(input: GenerateVideoPreviewInput, logger: Logger): Promise<void>;
}

export interface GenerateImageThumbnailInput {
  sourcePath: string;
  /** Extension must match `encoding.outputMime` -- ImageMagick infers the write format from it. */
  destPath: string;
  width: number;
  height: number;
  encoding: ImageEncoding;
}

/** ImageMagick flags for one format's encoding knobs, verified against this build's (7.1.2) actual behavior. */
function magickArgsForEncoding(encoding: ImageEncoding): string[] {
  switch (encoding.outputMime) {
    case "image/jpeg":
      return ["-quality", String(encoding.jpegQuality)];
    case "image/png":
      return ["-define", `png:compression-level=${encoding.pngCompressionLevel}`];
    case "image/webp":
      return [
        "-quality",
        String(encoding.webpQuality),
        "-define",
        `webp:lossless=${encoding.webpLossless ? "true" : "false"}`,
      ];
    case "image/gif":
      return [
        "-colors",
        String(encoding.gifMaxColors),
        "-dither",
        // ImageMagick's still-image path only has one error-diffusion mode
        // ("FloydSteinberg") -- every dither value but "none" collapses to
        // it here. Approximate for the still-image path; the video preview
        // path (generateVideoPreview below) passes ffmpeg the full value.
        encoding.gifDither === "none" ? "None" : "FloydSteinberg",
      ];
  }
}

/**
 * `-resize "<W>x<H>!"`: the trailing `!` forces ImageMagick to use exactly
 * these pixel dimensions rather than recomputing its own aspect-preserving
 * fit -- `width`/`height` are expected to already be the exact output of
 * `computeContainFitSize`/`computeShorterSideFitSize`, so re-deriving a fit
 * here could disagree with it by a rounding pixel and silently violate our
 * own contract.
 */
async function generateImageThumbnail(
  input: GenerateImageThumbnailInput,
  logger: Logger,
): Promise<void> {
  await runTool(
    "convert",
    [
      `${input.sourcePath}[0]`,
      "-auto-orient",
      "-resize",
      `${input.width}x${input.height}!`,
      ...magickArgsForEncoding(input.encoding),
      input.destPath,
    ],
    "convert",
    logger,
  );
}

export interface GenerateVideoMosaicInput {
  sourcePath: string;
  destPath: string;
  sourceWidth: number;
  sourceHeight: number;
  durationSeconds: number;
  tileRowCount: number;
  tileColumnCount: number;
  /** One tile's shorter-side target in pixels -- see `computeShorterSideFitSize`; the longer side is derived, never configured independently. */
  shorterSide: number;
  encoding: MosaicEncoding;
}

/** Maps a 1-100 JPEG quality to ffmpeg's mjpeg `-q:v` scale (2 = best, 31 = worst -- inverted and much coarser than JPEG's own percent scale). */
function mapJpegQualityToFfmpegQScale(jpegQuality: number): number {
  return Math.min(31, Math.max(2, Math.round(2 + ((100 - jpegQuality) * 29) / 100)));
}

/** ffmpeg output-codec flags for one mosaic encoding, verified against this build's actual behavior. */
function ffmpegMosaicArgsForEncoding(encoding: MosaicEncoding): string[] {
  switch (encoding.outputMime) {
    case "image/jpeg":
      return ["-q:v", String(mapJpegQualityToFfmpegQScale(encoding.jpegQuality))];
    case "image/png":
      return ["-compression_level", String(encoding.pngCompressionLevel)];
    case "image/webp":
      return [
        "-c:v",
        "libwebp",
        "-quality",
        String(encoding.webpQuality),
        "-lossless",
        encoding.webpLossless ? "1" : "0",
      ];
  }
}

/**
 * Extracts one scaled frame at `timestampSeconds`, stepping back by
 * `stepBackSeconds` and retrying if that instant has no frame.
 *
 * Both halves matter. ffmpeg does not treat "seek past the last frame" as
 * an error: it writes nothing, prints "Output file is empty, nothing was
 * encoded", and **exits 0**. `runTool` only raises on a nonzero exit, so
 * this silently handed back a frame path naming no file, and the run fell
 * over a stage later -- the composite reporting "No such file or
 * directory" for a temp frame, with nothing left to connect it to a
 * timestamp past the end of the video.
 *
 * And a sample can legitimately land past the last frame even with an
 * honest duration: `-ss` emits the first frame at or *after* its target,
 * while the final frame's own display window extends to the end of the
 * stream. So any sample inside that last window finds nothing after it.
 * The centre-of-bucket sampler puts its last sample within
 * `duration / 2n` of the end, which is inside that window whenever a clip
 * has fewer than roughly `2n` frames. Stepping back one sampling interval
 * lands on the previous bucket's frame -- a repeated tile at worst, which
 * beats refusing to thumbnail a short clip at all.
 */
const MAX_STEP_BACK_ATTEMPTS = 3;

async function extractFrame(
  sourcePath: string,
  framePath: string,
  timestampSeconds: number,
  stepBackSeconds: number,
  frame: Dimensions,
  logger: Logger,
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_STEP_BACK_ATTEMPTS; attempt++) {
    const target = Math.max(0, timestampSeconds - attempt * stepBackSeconds);
    if (await tryExtractFrame(sourcePath, framePath, target, frame, logger)) return;
    if (target === 0) break;
  }
  throw new ThumbnailGenerationError(
    `ffmpeg wrote no frame at ${timestampSeconds.toFixed(3)}s, or at any earlier sample, and still exited 0 -- the source has no decodable video frames there`,
  );
}

/** Resolves false when ffmpeg succeeded but wrote nothing -- see `extractFrame`. */
async function tryExtractFrame(
  sourcePath: string,
  framePath: string,
  timestampSeconds: number,
  frame: Dimensions,
  logger: Logger,
): Promise<boolean> {
  await runTool(
    "ffmpeg",
    [
      "-y",
      // Bare flag, no value: confirmed empirically that this build's CLI
      // treats "-autorotate 1" as two separate tokens (the boolean flag,
      // then a stray "1" ffmpeg then tries to apply to the *output* file,
      // erroring "input option ... applied to output url"), unlike e.g.
      // "-tile-rows <n>"-style options. Mirrors "-noautorotate" (also
      // bare) used elsewhere for fixture setup.
      "-autorotate",
      "-ss",
      timestampSeconds.toFixed(3),
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-update",
      "1",
      "-vf",
      `scale=${frame.width}:${frame.height}`,
      framePath,
    ],
    "ffmpeg (frame extraction)",
    logger,
  );
  return fs.existsSync(framePath);
}

/**
 * Samples `tileRowCount * tileColumnCount` frames at evenly-spaced,
 * center-of-bucket timestamps (deliberately avoiding literal first/last
 * frames, often black/blank/credits), scales each to `frame` (via
 * `computeShorterSideFitSize`, computed once -- every frame sampled from this
 * one source shares its aspect ratio, so `frame` is constant across the
 * whole run, not recomputed per frame), then composites the grid via
 * ffmpeg's `xstack` filter into one still image, encoded per
 * `ffmpegMosaicArgsForEncoding`. No `pad`: since every sampled frame already
 * lands on `frame`'s exact dimensions (same source, same aspect ratio, same
 * scale), there's no leftover space to letterbox -- unlike the fixed-box
 * mosaic design this replaced, which needed `pad` precisely because a
 * declared tile box could disagree with the source's own orientation.
 * `-autorotate 1` is passed explicitly rather than relying on ffmpeg's own
 * default (on since ~4.4, unconfirmed as pinned anywhere in this project) --
 * see `docs/architecture/thumbnails.md`. Temp per-frame PNGs are written
 * under a fresh temp dir, always removed in `finally`.
 */
async function generateVideoMosaic(input: GenerateVideoMosaicInput, logger: Logger): Promise<void> {
  const tileCount = input.tileRowCount * input.tileColumnCount;
  const frame = computeShorterSideFitSize(
    { width: input.sourceWidth, height: input.sourceHeight },
    input.shorterSide,
  );

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sync1-mosaic-"));
  try {
    const framePaths: string[] = [];
    for (let i = 0; i < tileCount; i++) {
      const timestampSeconds = (input.durationSeconds * (i + 0.5)) / tileCount;
      const framePath = path.join(tempDir, `frame-${i}.png`);
      await extractFrame(
        input.sourcePath,
        framePath,
        timestampSeconds,
        input.durationSeconds / tileCount,
        frame,
        logger,
      );
      framePaths.push(framePath);
    }

    const layout = framePaths
      .map((_, i) => {
        const row = Math.floor(i / input.tileColumnCount);
        const col = i % input.tileColumnCount;
        return `${col * frame.width}_${row * frame.height}`;
      })
      .join("|");

    await runTool(
      "ffmpeg",
      [
        "-y",
        ...framePaths.flatMap((framePath) => ["-i", framePath]),
        "-filter_complex",
        `xstack=inputs=${tileCount}:layout=${layout}`,
        "-frames:v",
        "1",
        "-update",
        "1",
        ...ffmpegMosaicArgsForEncoding(input.encoding),
        input.destPath,
      ],
      "ffmpeg (mosaic composite)",
      logger,
    );
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

export interface GenerateVideoPreviewInput {
  sourcePath: string;
  destPath: string;
  sourceWidth: number;
  sourceHeight: number;
  durationSeconds: number;
  frameCount: number;
  /**
   * Per-frame display duration. Converted to an input framerate
   * (`1000 / frameDelayMs`) -- neither muxer takes a per-frame duration
   * flag directly. Fidelity differs by `encoding.outputMime`: GIF stores
   * the delay in centiseconds (10ms floor granularity, and a stored value
   * of 0-1cs is clamped to 100ms by most browsers), animated WebP stores
   * milliseconds exactly -- see docs/cli/thumbnail_policy.md.
   */
  frameDelayMs: number;
  /** Each frame's shorter-side target in pixels -- see `computeShorterSideFitSize`. */
  shorterSide: number;
  encoding: PreviewEncoding;
}

/**
 * ffmpeg's `paletteuse` filter takes the exact same dither names our own
 * `ThumbnailGifDither` enum does (verified against this build), so the
 * value passes straight through with no mapping -- except `bayer`, which
 * additionally takes a `bayer_scale` sub-parameter ffmpeg has no default
 * opinion on. There's no policy field for it (mirroring
 * `reserve_transparent=0` below -- both are fixed rather than exposed), so
 * a mid-range constant is hardcoded here.
 */
const BAYER_SCALE = 3;

function paletteuseFilterFor(
  encoding: Extract<PreviewEncoding, { outputMime: "image/gif" }>,
): string {
  const bayerScale = encoding.gifDither === "bayer" ? `:bayer_scale=${BAYER_SCALE}` : "";
  return `paletteuse=dither=${encoding.gifDither}${bayerScale}`;
}

/**
 * Samples `frameCount` frames at evenly-spaced, center-of-bucket
 * timestamps -- identical extraction shape to `generateVideoMosaic` above
 * (same timestamp formula, same per-frame `ffmpeg` invocation, same
 * `computeShorterSideFitSize` frame sizing), since stage 1 (getting N
 * correctly-scaled PNG frames onto disk) doesn't care what stage 2 does
 * with them. Stage 2 branches on `encoding.outputMime`:
 *
 * - `image/gif`: the standard two-pass high-quality animated-GIF pipeline.
 *   `palettegen=max_colors=N:reserve_transparent=0` builds one shared
 *   palette across every frame (`reserve_transparent=0` is hardcoded, not a
 *   policy field -- our frames are always opaque, so the reserved slot is
 *   pure waste); `paletteuse=dither=D` re-encodes the frame sequence
 *   against that palette into the final looping GIF (`-loop 0`).
 * - `image/webp`: a single pass, `-c:v libwebp_anim`, directly on the same
 *   frame sequence -- animated WebP needs no separate palette step.
 *
 * Both passes read the same on-disk frame sequence via ffmpeg's image2
 * demuxer (`frame-%d.png`, `-start_number 0` explicit rather than relying
 * on its default) at the same input framerate, derived from `frameDelayMs`.
 * Temporary per-frame PNGs (and, for GIF, the intermediate palette) live
 * under a fresh temp directory, always removed in a `finally`.
 */
async function generateVideoPreview(
  input: GenerateVideoPreviewInput,
  logger: Logger,
): Promise<void> {
  const frame = computeShorterSideFitSize(
    { width: input.sourceWidth, height: input.sourceHeight },
    input.shorterSide,
  );
  const fps = 1000 / input.frameDelayMs;

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sync1-preview-"));
  try {
    for (let i = 0; i < input.frameCount; i++) {
      const timestampSeconds = (input.durationSeconds * (i + 0.5)) / input.frameCount;
      const framePath = path.join(tempDir, `frame-${i}.png`);
      await extractFrame(
        input.sourcePath,
        framePath,
        timestampSeconds,
        input.durationSeconds / input.frameCount,
        frame,
        logger,
      );
    }

    const framePattern = path.join(tempDir, "frame-%d.png");

    if (input.encoding.outputMime === "image/gif") {
      const palettePath = path.join(tempDir, "palette.png");
      await runTool(
        "ffmpeg",
        [
          "-y",
          "-start_number",
          "0",
          "-framerate",
          fps.toFixed(6),
          "-i",
          framePattern,
          "-vf",
          `palettegen=max_colors=${input.encoding.gifMaxColors}:reserve_transparent=0`,
          palettePath,
        ],
        "ffmpeg (gif palette)",
        logger,
      );

      await runTool(
        "ffmpeg",
        [
          "-y",
          "-start_number",
          "0",
          "-framerate",
          fps.toFixed(6),
          "-i",
          framePattern,
          "-i",
          palettePath,
          "-lavfi",
          paletteuseFilterFor(input.encoding),
          "-loop",
          "0",
          input.destPath,
        ],
        "ffmpeg (gif composite)",
        logger,
      );
    } else {
      await runTool(
        "ffmpeg",
        [
          "-y",
          "-start_number",
          "0",
          "-framerate",
          fps.toFixed(6),
          "-i",
          framePattern,
          "-c:v",
          "libwebp_anim",
          "-quality",
          String(input.encoding.webpQuality),
          "-lossless",
          input.encoding.webpLossless ? "1" : "0",
          "-loop",
          "0",
          input.destPath,
        ],
        "ffmpeg (webp composite)",
        logger,
      );
    }
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

export const realThumbnailGenerator: ThumbnailGenerator = {
  generateImageThumbnail,
  generateVideoMosaic,
  generateVideoPreview,
};
