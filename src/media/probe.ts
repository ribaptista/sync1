import { execFile } from "node:child_process";

/**
 * Thrown when the external tool itself is missing (`ENOENT` on spawn) --
 * fatal, unlike an ordinary probe failure (which just means "this file
 * isn't recognized as media" and returns `undefined`). Nothing can be
 * thumbnailed at all without the tool, so this is meant to propagate and
 * abort the whole run rather than being silently skipped per-file.
 */
export class MediaToolMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaToolMissingError";
  }
}

export interface ProbedImage {
  kind: "image";
  mimeType: string;
  width: number;
  height: number;
}

export interface ProbedVideo {
  kind: "video";
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
}

export type ProbedMedia = ProbedImage | ProbedVideo;

export interface MediaProber {
  /** `undefined` means "not recognized as thumbnailable media" -- normal, non-fatal. */
  detectMedia(absolutePath: string): Promise<ProbedMedia | undefined>;
}

function execFileP(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
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

// ImageMagick's `%m` format name -> mime type. Deliberately a small,
// curated whitelist rather than a general mapping: identify(1) will
// happily report a format for plenty of non-image containers too (e.g. it
// reports "MP4" for an actual video file, since it has an MP4 coder) --
// only formats in this table are ever treated as an image; anything else
// falls through to the video probe instead of being guessed at.
const IMAGE_FORMAT_TO_MIME: Record<string, string> = {
  JPEG: "image/jpeg",
  PNG: "image/png",
  GIF: "image/gif",
  BMP: "image/bmp",
  TIFF: "image/tiff",
  WEBP: "image/webp",
  HEIC: "image/heic",
  // Canon RAW -- read-only in ImageMagick (`identify -list format` shows
  // "CR2 DNG r--", no encoder), so a thumbnail generated from one is
  // always forced to `.jpg` regardless of the source's own extension --
  // see RAW_IMAGE_MIME_TYPES in src/fs/thumbnail.ts.
  CR2: "image/x-canon-cr2",
};

async function probeImage(absolutePath: string): Promise<ProbedImage | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileP("identify", [
      "-auto-orient",
      "-format",
      "%m|%w|%h",
      `${absolutePath}[0]`,
    ]));
  } catch (err) {
    if (isEnoent(err)) {
      throw new MediaToolMissingError(
        '"identify" (ImageMagick) not found on PATH -- required for thumbnail generation',
      );
    }
    // Nonzero exit: identify couldn't parse this file as an image at all.
    return undefined;
  }

  const firstLine = stdout.trim().split("\n")[0] ?? "";
  const [format, widthRaw, heightRaw] = firstLine.split("|");
  const mimeType = format ? IMAGE_FORMAT_TO_MIME[format] : undefined;
  if (!mimeType) return undefined;

  const width = Number(widthRaw);
  const height = Number(heightRaw);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;

  return { kind: "image", mimeType, width, height };
}

// ffprobe's `format_name` is a demuxer name, sometimes shared by several
// real containers with no way to tell them apart from format_name alone
// (a real .mp4 and a real .mov both report "mov,mp4,m4a,3gp,3g2,mj2"; a
// real .mkv and a real .webm both report "matroska,webm") -- this table
// picks one representative mime type per family, first-token keyed. Exact
// subtype precision doesn't matter for thumbnail_policy's own matching
// (mime types there are commonly just "video/*"), only that it's some
// valid "video/..." type.
const VIDEO_FORMAT_TO_MIME: Record<string, string> = {
  mov: "video/mp4",
  matroska: "video/webm",
  avi: "video/x-msvideo",
  ogg: "video/ogg",
};

interface FfprobeStream {
  width?: number;
  height?: number;
  duration?: string;
  side_data_list?: Array<{ rotation?: number }>;
  tags?: { rotate?: string };
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string };
}

/**
 * Reads a stream's declared display rotation, in degrees -- the Display
 * Matrix side data ffmpeg >= 4.4-ish writes by default (`side_data_list[].
 * rotation`) takes precedence when present; the legacy pre-Display-Matrix
 * `tags.rotate` convention is checked only as a fallback. Exported because
 * both branches, and their precedence, are otherwise unfixturable with
 * real ffmpeg -- a real encode only ever produces one or the other, never
 * both at once for the same file -- so a unit test exercising the
 * precedence rule directly is the only real coverage either branch gets.
 */
export function resolveRotationDegrees(stream: FfprobeStream): number {
  const sideDataRotation = stream.side_data_list?.find((e) => e.rotation !== undefined)?.rotation;
  if (sideDataRotation !== undefined) return sideDataRotation;
  const tagRotation = stream.tags?.rotate !== undefined ? Number(stream.tags.rotate) : undefined;
  if (tagRotation !== undefined && Number.isFinite(tagRotation)) return tagRotation;
  return 0;
}

/** Normalizes to [0, 360) first so -90/270 and -270/90 are recognized as equivalent. 180 (or -180) swaps neither dimension. */
export function rotationSwapsDimensions(degrees: number): boolean {
  const normalized = ((degrees % 360) + 360) % 360;
  return normalized === 90 || normalized === 270;
}

async function probeVideo(absolutePath: string): Promise<ProbedVideo | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileP("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,duration",
      "-show_entries",
      "stream_side_data=rotation",
      "-show_entries",
      "stream_tags=rotate",
      "-show_entries",
      "format=format_name,duration",
      "-of",
      "json",
      absolutePath,
    ]));
  } catch (err) {
    if (isEnoent(err)) {
      throw new MediaToolMissingError(
        '"ffprobe" (ffmpeg) not found on PATH -- required for thumbnail generation',
      );
    }
    return undefined;
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    return undefined;
  }

  const firstToken = parsed.format?.format_name?.split(",")[0];
  const mimeType = firstToken ? VIDEO_FORMAT_TO_MIME[firstToken] : undefined;
  if (!mimeType) return undefined;

  const stream = parsed.streams?.[0];
  const rawWidth = stream?.width;
  const rawHeight = stream?.height;
  // The *video stream's* own duration, not the container's, and the
  // difference is not academic: a phone keeps recording audio for a
  // fraction of a second after the last video frame, so the container --
  // whose duration is the longest stream's -- overstates how far into the
  // file a frame can still be found. Every sampler downstream
  // (generateVideoMosaic, generateVideoPreview) places its last sample at
  // `duration * (n - 0.5) / n`, which lands past the final frame once that
  // audio tail exceeds `duration / 2n`; ffmpeg then writes no frame at all
  // and still exits 0. Measured on 8 real phone clips, the tail ran
  // 43-208ms while the budget was 51-220ms -- routinely over.
  //
  // Falls back to the container duration: not every container reports a
  // per-stream duration (ffprobe gives "N/A", which `Number` makes NaN),
  // and an approximate duration is still far better than refusing to
  // thumbnail the file.
  const streamDuration = stream?.duration !== undefined ? Number(stream.duration) : undefined;
  const containerDuration =
    parsed.format?.duration !== undefined ? Number(parsed.format.duration) : undefined;
  const durationSeconds =
    streamDuration !== undefined && Number.isFinite(streamDuration)
      ? streamDuration
      : containerDuration;
  if (
    rawWidth === undefined ||
    rawHeight === undefined ||
    durationSeconds === undefined ||
    !Number.isFinite(durationSeconds)
  ) {
    return undefined;
  }

  // ffmpeg's own frame decoding auto-rotates (see generateVideoMosaic's
  // explicit -autorotate), so the *displayed* dimensions -- what every
  // downstream consumer (mosaic frame sizing) actually needs -- can
  // disagree with the raw stream dimensions ffprobe reports by default.
  const swapped = stream !== undefined && rotationSwapsDimensions(resolveRotationDegrees(stream));
  const width = swapped ? rawHeight : rawWidth;
  const height = swapped ? rawWidth : rawHeight;

  return { kind: "video", mimeType, width, height, durationSeconds };
}

export const realMediaProber: MediaProber = {
  async detectMedia(absolutePath: string): Promise<ProbedMedia | undefined> {
    const image = await probeImage(absolutePath);
    if (image) return image;
    // Falls through here both when identify failed outright *and* when it
    // succeeded but reported a format outside IMAGE_FORMAT_TO_MIME (e.g. a
    // real video file) -- see probeImage's comment.
    return probeVideo(absolutePath);
  },
};
