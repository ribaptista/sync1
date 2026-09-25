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

/**
 * Neither tool could make sense of the file. Deliberately *not* `undefined`:
 * this used to be, and an unreadable source was then indistinguishable from
 * a deliberate 'skip' policy match, so a corrupt original was silently
 * re-probed on every run forever with no error, count, or log line to show
 * for it. Carrying a reason -- and a variant every caller must handle --
 * is what makes that impossible to drop on the floor again.
 */
export interface ProbeUnreadable {
  kind: "unreadable";
  /** What the tools themselves said, e.g. `identify: Not a JPEG file: starts with 0x00 0x00`. */
  reason: string;
}

export type ProbeOutcome = ProbedMedia | ProbeUnreadable;

export interface MediaProber {
  /** Never throws for an ordinary bad file -- an `unreadable` outcome is normal and non-fatal. */
  detectMedia(absolutePath: string): Promise<ProbeOutcome>;
}

/**
 * `stdout`/`stderr` are attached to the rejection, mirroring
 * thumbnail-generate.ts's own runner: a nonzero exit does not mean the tool
 * produced nothing useful. `identify` will report a complete
 * `%m|%w|%h` line *and* exit 1 over a recoverable warning (an invalid
 * colormap index, say), and discarding that answer meant refusing to
 * thumbnail a perfectly readable file.
 */
function execFileP(command: string, args: string[]): Promise<{ stdout: string }> {
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
        resolve({ stdout });
      },
    );
  });
}

/**
 * The tool's own first line of complaint, with the file path stripped from
 * both ends of it. Both tools name the file in their message -- ffprobe
 * prefixes it, ImageMagick suffixes it in backticks -- and the caller
 * already logs `path` as its own field, so repeating it here would spend
 * most of the budget restating what's beside it.
 */
function toolReason(err: unknown, absolutePath: string): string {
  const stderr = typeof err === "object" && err !== null ? (err as { stderr?: string }).stderr : "";
  const firstLine = (stderr ?? "").split("\n")[0]?.trim() ?? "";
  const withoutSuffix = firstLine.split(" `")[0] ?? firstLine;
  const withoutPathPrefix = withoutSuffix.startsWith(`${absolutePath}: `)
    ? withoutSuffix.slice(absolutePath.length + 2)
    : withoutSuffix;
  return withoutPathPrefix.replace(/^\w+:\s*/, "").slice(0, 160);
}

function errorStdout(err: unknown): string {
  return typeof err === "object" && err !== null ? ((err as { stdout?: string }).stdout ?? "") : "";
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
  // "CR2 DNG r--", no encoder). Harmless here: a policy's own required
  // `output_mime` decides what gets written, so the source never needs an
  // encoder of its own.
  CR2: "image/x-canon-cr2",
};

/**
 * `media` set means success. `reason` set means the tool refused the file
 * outright. **Neither** means the tool read it fine but reported a format
 * outside this probe's own table -- not an error, and the signal
 * `detectMedia` uses to fall through from image to video (identify reports
 * "MP4" for real videos, so that fall-through is load-bearing).
 */
interface ProbeAttempt<T> {
  media?: T;
  reason?: string;
}

async function probeImage(absolutePath: string): Promise<ProbeAttempt<ProbedImage>> {
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
    // A nonzero exit is not proof it produced nothing: identify reports a
    // complete answer alongside a recoverable warning (an invalid colormap
    // index, say) and still exits 1. Take the answer when there is one, and
    // only treat the exit code as a verdict when there isn't.
    const salvaged = parseIdentifyOutput(errorStdout(err));
    return salvaged
      ? { media: salvaged }
      : { reason: `identify: ${toolReason(err, absolutePath)}` };
  }

  const parsed = parseIdentifyOutput(stdout);
  // No reason: identify read it, it just isn't a still-image format we
  // handle -- almost always a video, on its way to probeVideo.
  return parsed ? { media: parsed } : {};
}

function parseIdentifyOutput(stdout: string): ProbedImage | undefined {
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
  // ffprobe names the WMV/ASF container "asf", never "wmv" -- so a real
  // 1920x1080 WMV probed perfectly and was then discarded for want of a
  // mime string, even for a policy naming video/x-ms-wmv outright.
  asf: "video/x-ms-wmv",
  mpeg: "video/mpeg",
  mpegvideo: "video/mpeg",
  // Correct for a transport stream even though no policy has to name it.
  mpegts: "video/mp2t",
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

async function probeVideo(absolutePath: string): Promise<ProbeAttempt<ProbedVideo>> {
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
    // Same salvage rule as probeImage: ffprobe can emit a complete JSON
    // document and still exit nonzero over a stream it disliked.
    const salvaged = parseFfprobeOutput(errorStdout(err));
    return salvaged ? { media: salvaged } : { reason: `ffprobe: ${toolReason(err, absolutePath)}` };
  }

  const parsed = parseFfprobeOutput(stdout);
  // No reason: ffprobe read it, it just isn't a container we map -- the
  // same "not my kind of file" signal probeImage uses.
  return parsed ? { media: parsed } : {};
}

function parseFfprobeOutput(stdout: string): ProbedVideo | undefined {
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
  async detectMedia(absolutePath: string): Promise<ProbeOutcome> {
    const image = await probeImage(absolutePath);
    if (image.media) return image.media;
    // Falls through here both when identify failed outright *and* when it
    // succeeded but reported a format outside IMAGE_FORMAT_TO_MIME (e.g. a
    // real video file) -- see probeImage's comment.
    const video = await probeVideo(absolutePath);
    if (video.media) return video.media;

    // Both tools' complaints, not just the last one: for a zero-filled JPEG
    // identify's "Not a JPEG file: starts with 0x00 0x00" is far more
    // useful than ffprobe's generic refusal, while for a truncated MP4 it
    // is the other way round. Picking between them would be a heuristic to
    // get wrong; whoever reads the log wants whichever applies.
    const reasons = [image.reason, video.reason].filter((r): r is string => r !== undefined);
    return {
      kind: "unreadable",
      reason:
        reasons.length > 0
          ? reasons.join(" | ")
          : "neither identify nor ffprobe recognized this as a thumbnailable image or video",
    };
  },
};
