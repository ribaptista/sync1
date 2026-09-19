import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logger.js";
import { MediaToolMissingError } from "./probe.js";

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
 * Computes the frame size for one mosaic tile: `shortSide` is a policy's
 * configured `tileSize`, the pixel length of a tile's *shorter* side --
 * scale is derived from whichever of `source`'s own dimensions is smaller,
 * and both axes are scaled by that same factor, so the long side falls out
 * of `source`'s own aspect ratio rather than being configured directly.
 * Deliberately has no orientation concept at all (no portrait/landscape
 * branch, unlike `computeContainFitSize` above) -- every frame sampled from
 * one video shares that video's aspect ratio, so there's no "declared box
 * vs. source orientation" pairing left to get wrong, structurally, not by
 * convention.
 */
export function computeMosaicFrameSize(source: Dimensions, shortSide: number): Dimensions {
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

export interface ThumbnailGenerator {
  generateImageThumbnail(input: GenerateImageThumbnailInput, logger: Logger): Promise<void>;
  generateVideoMosaic(input: GenerateVideoMosaicInput, logger: Logger): Promise<void>;
}

export interface GenerateImageThumbnailInput {
  sourcePath: string;
  /** Extension determines the output format (and whether `-quality` applies) -- must match the original's own extension, per the thumbnail-filename convention. */
  destPath: string;
  width: number;
  height: number;
  jpegQuality: number;
}

const JPEG_EXTENSION = /\.jpe?g$/i;

/**
 * `-resize "<W>x<H>!"`: the trailing `!` forces ImageMagick to use exactly
 * these pixel dimensions rather than recomputing its own aspect-preserving
 * fit -- `width`/`height` are expected to already be the exact output of
 * `computeContainFitSize`, so re-deriving a fit here could disagree with it
 * by a rounding pixel and silently violate our own contract.
 */
async function generateImageThumbnail(
  input: GenerateImageThumbnailInput,
  logger: Logger,
): Promise<void> {
  const isJpeg = JPEG_EXTENSION.test(input.destPath);
  await runTool(
    "convert",
    [
      `${input.sourcePath}[0]`,
      "-auto-orient",
      "-resize",
      `${input.width}x${input.height}!`,
      ...(isJpeg ? ["-quality", String(input.jpegQuality)] : []),
      input.destPath,
    ],
    "convert",
    logger,
  );
}

export interface GenerateVideoMosaicInput {
  sourcePath: string;
  /** Always a .jpg destination -- video mosaics are always JPEG regardless of the source container. */
  destPath: string;
  sourceWidth: number;
  sourceHeight: number;
  durationSeconds: number;
  tileRowCount: number;
  tileColumnCount: number;
  /** One tile's shorter-side target in pixels -- see `computeMosaicFrameSize`; the longer side is derived, never configured independently. */
  tileSize: number;
  jpegQuality: number;
}

/** Maps a 1-100 JPEG quality to ffmpeg's mjpeg `-q:v` scale (2 = best, 31 = worst -- inverted and much coarser than JPEG's own percent scale). */
function mapJpegQualityToFfmpegQScale(jpegQuality: number): number {
  return Math.min(31, Math.max(2, Math.round(2 + ((100 - jpegQuality) * 29) / 100)));
}

/**
 * Samples `tileRowCount * tileColumnCount` frames at evenly-spaced,
 * center-of-bucket timestamps (deliberately avoiding literal first/last
 * frames, often black/blank/credits), scales each to `frame` (via
 * `computeMosaicFrameSize`, computed once -- every frame sampled from this
 * one source shares its aspect ratio, so `frame` is constant across the
 * whole run, not recomputed per frame), then composites the grid via
 * ffmpeg's `xstack` filter into one JPEG. No `pad`: since every sampled
 * frame already lands on `frame`'s exact dimensions (same source, same
 * aspect ratio, same scale), there's no leftover space to letterbox --
 * unlike the fixed-box mosaic design this replaced, which needed `pad`
 * precisely because a declared tile box could disagree with the source's
 * own orientation. `-autorotate 1` is passed explicitly rather than relying
 * on ffmpeg's own default (on since ~4.4, unconfirmed as pinned anywhere in
 * this project) -- see `docs/architecture/thumbnails.md`. Temp per-frame
 * PNGs are written under a fresh temp dir, always removed in `finally`.
 */
async function generateVideoMosaic(input: GenerateVideoMosaicInput, logger: Logger): Promise<void> {
  const tileCount = input.tileRowCount * input.tileColumnCount;
  const frame = computeMosaicFrameSize(
    { width: input.sourceWidth, height: input.sourceHeight },
    input.tileSize,
  );

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sync1-mosaic-"));
  try {
    const framePaths: string[] = [];
    for (let i = 0; i < tileCount; i++) {
      const timestampSeconds = (input.durationSeconds * (i + 0.5)) / tileCount;
      const framePath = path.join(tempDir, `frame-${i}.png`);
      await runTool(
        "ffmpeg",
        [
          "-y",
          // Bare flag, no value: confirmed empirically that this build's
          // CLI treats "-autorotate 1" as two separate tokens (the boolean
          // flag, then a stray "1" ffmpeg then tries to apply to the
          // *output* file, erroring "input option ... applied to output
          // url"), unlike e.g. "-tile-rows <n>"-style options. Mirrors
          // "-noautorotate" (also bare) used elsewhere for fixture setup.
          "-autorotate",
          "-ss",
          timestampSeconds.toFixed(3),
          "-i",
          input.sourcePath,
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
        "-q:v",
        String(mapJpegQualityToFfmpegQScale(input.jpegQuality)),
        input.destPath,
      ],
      "ffmpeg (mosaic composite)",
      logger,
    );
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

export const realThumbnailGenerator: ThumbnailGenerator = {
  generateImageThumbnail,
  generateVideoMosaic,
};
