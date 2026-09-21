import type Database from "better-sqlite3";

export type ThumbnailPolicyAction = "skip" | "generate";
export type ThumbnailPolicyMediaType = "image" | "video";
export type ThumbnailResizingStrategy = "fit_to_box" | "resize_shorter_side";
export type ThumbnailOutputType = "mosaic" | "preview";
export type ThumbnailOutputMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
export type ThumbnailGifDither =
  | "none"
  | "bayer"
  | "heckbert"
  | "floyd_steinberg"
  | "sierra2"
  | "sierra2_4a"
  | "sierra3"
  | "burkes"
  | "atkinson";

const MIME_TYPE_PATTERN = /^[a-zA-Z0-9.+-]+\/(\*|[a-zA-Z0-9.+-]+)$/;
/** Matches the table's own CHECK constraint: non-empty, alphanumeric plus underscore only -- see 0007's migration comment and src/fs/thumbnail.ts's filename-grammar use of it. */
const NAME_PATTERN = /^[A-Za-z0-9_]+$/;

interface Base {
  id: number;
  name: string;
  glob: string;
  mimeTypes: string[];
  createdAt: string;
}

/**
 * Two independent axes, combined into a flat union: SIZING (how many
 * pixels the output has -- `resizingStrategy` for image, `outputType`
 * for video) and ENCODING (how those pixels are compressed --
 * `outputMime`). They never interact except for which encodings are
 * legal for which sizing branch (a mosaic is never animated, a preview
 * is never still -- see `LEGAL_OUTPUT_MIMES` below), so each axis is
 * declared once, and `Generate<>` produces their product rather than a
 * hand-written 14-arm union repeating every field across every arm that
 * has it.
 */
type FitToBox = {
  mediaType: "image";
  resizingStrategy: "fit_to_box";
  imageWidth: number;
  imageHeight: number;
};
type ShorterSideSizing = {
  mediaType: "image";
  resizingStrategy: "resize_shorter_side";
  shorterSide: number;
};
type MosaicSizing = {
  mediaType: "video";
  outputType: "mosaic";
  shorterSide: number;
  tileRowCount: number;
  tileColumnCount: number;
};
type PreviewSizing = {
  mediaType: "video";
  outputType: "preview";
  shorterSide: number;
  frameCount: number;
  frameDelayMs: number;
};

type JpegEncoding = { outputMime: "image/jpeg"; jpegQuality: number };
type PngEncoding = { outputMime: "image/png"; pngCompressionLevel: number };
type WebpEncoding = { outputMime: "image/webp"; webpQuality: number; webpLossless: boolean };
type GifEncoding = { outputMime: "image/gif"; gifMaxColors: number; gifDither: ThumbnailGifDither };

/**
 * Distributes over both unions -- `Generate<A | B, C | D>` is a genuine
 * flat union `(A&C)|(A&D)|(B&C)|(B&D)`, not a union nested inside an
 * intersection, so discriminant narrowing on `resizingStrategy` /
 * `outputType` / `outputMime` behaves exactly as it does for a
 * hand-written union, and `Extract<...>` keeps working. Verified against
 * a real `tsc --strict` compile before this file was written, including
 * that an illegal combination (e.g. `outputType: "mosaic"` with
 * `outputMime: "image/gif"`) is rejected at the type level.
 */
type Generate<S, E> = S extends unknown
  ? E extends unknown
    ? Base & { action: "generate" } & S & E
    : never
  : never;

/**
 * `Omit` is NOT distributive over a union on its own -- `keyof` on a
 * union computes the *intersection* of member keys, so plain
 * `Omit<ThumbnailPolicyRow, "id">` would collapse the whole 15-arm union
 * down to just the fields every arm shares, silently losing every
 * discriminant-specific field (`Extract<..., {resizingStrategy:
 * "fit_to_box"}>` on the result resolves to `never`). This forces
 * distribution first, exactly like `Generate<>` above, before applying
 * `Omit` to each already-narrowed member individually.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Flat, not nested: every existing consumer reads a field like
 * `policy.imageWidth` or `policy.shorterSide` directly, and nesting a
 * `generate: {...}` sub-object would force an `if (policy.action ===
 * "generate")` unwrap everywhere for no safety gain over the discriminants
 * already living on `action`/`mediaType`/`resizingStrategy`/`outputType`/
 * `outputMime`. A 'skip' row carries none of them. A 'generate' row is
 * exactly one of 14 combinations -- an image policy picks a
 * `resizingStrategy`, a video policy picks an `outputType` (together,
 * SIZING), then every row picks an `outputMime` (ENCODING) -- never
 * fields from a sizing or encoding branch it isn't. `shorterSide` is
 * shared by every non-`fit_to_box` sizing branch (one output unit's
 * shorter side -- an image's own, one mosaic tile's, or one preview
 * frame's); `image/gif` is legal for a still image but not a mosaic (a
 * one-frame "animation" is strictly worse than any alternative), and
 * `image/jpeg`/`image/png` are legal for a still image or a mosaic but
 * never a preview (never animated) -- see `LEGAL_OUTPUT_MIMES`.
 */
export type ThumbnailPolicyRow =
  | (Base & { action: "skip" })
  | Generate<FitToBox | ShorterSideSizing, JpegEncoding | PngEncoding | WebpEncoding | GifEncoding>
  | Generate<MosaicSizing, JpegEncoding | PngEncoding | WebpEncoding>
  | Generate<PreviewSizing, GifEncoding | WebpEncoding>;

/** What a policy match actually is -- a 'skip' row is never useful past the fact that it matched. */
export type ThumbnailPolicyGenerateRow = Extract<ThumbnailPolicyRow, { action: "generate" }>;

export type ThumbnailPolicyCreateInput = DistributiveOmit<ThumbnailPolicyRow, "id" | "createdAt">;

/**
 * Deliberately NOT unioned like `ThumbnailPolicyCreateInput`: a patch is
 * merged against an *existing* row whose branch may itself be changing, so
 * "partial-if-staying, full-if-switching" is a fact about the merge
 * (runtime, in `update()`), not the shape of `changes` in isolation -- and
 * the one real caller (the CLI, built from independently-optional string
 * flags) can never statically know the existing row's branch anyway.
 */
export interface ThumbnailPolicyUpdate {
  name?: string;
  glob?: string;
  action?: ThumbnailPolicyAction;
  mimeTypes?: string[];
  mediaType?: ThumbnailPolicyMediaType;
  resizingStrategy?: ThumbnailResizingStrategy;
  imageWidth?: number;
  imageHeight?: number;
  shorterSide?: number;
  outputType?: ThumbnailOutputType;
  tileRowCount?: number;
  tileColumnCount?: number;
  frameCount?: number;
  frameDelayMs?: number;
  outputMime?: ThumbnailOutputMime;
  jpegQuality?: number;
  pngCompressionLevel?: number;
  webpQuality?: number;
  webpLossless?: boolean;
  gifMaxColors?: number;
  gifDither?: ThumbnailGifDither;
}

/** Every field a row could possibly have, regardless of which branch is actually live -- the all-nullable shape both the SQL layer and `update()`'s merge work in. */
interface FlatPolicyFields {
  name: string;
  glob: string;
  action: ThumbnailPolicyAction;
  mimeTypes: string[];
  mediaType: ThumbnailPolicyMediaType | null;
  resizingStrategy: ThumbnailResizingStrategy | null;
  imageWidth: number | null;
  imageHeight: number | null;
  shorterSide: number | null;
  outputType: ThumbnailOutputType | null;
  tileRowCount: number | null;
  tileColumnCount: number | null;
  frameCount: number | null;
  frameDelayMs: number | null;
  outputMime: ThumbnailOutputMime | null;
  jpegQuality: number | null;
  pngCompressionLevel: number | null;
  webpQuality: number | null;
  webpLossless: boolean | null;
  gifMaxColors: number | null;
  gifDither: ThumbnailGifDither | null;
}

/** Every non-discriminant field -- i.e. every `FlatPolicyFields` key except `name`/`glob`/`action`/`mimeTypes` and the five discriminants (`mediaType`/`resizingStrategy`/`outputType`/`outputMime` -- these are handled explicitly, not through the generic per-field lookup below, exactly like a `skip` row's absent `action` branch never goes through it either). */
export type GenerateFieldName =
  | "imageWidth"
  | "imageHeight"
  | "shorterSide"
  | "tileRowCount"
  | "tileColumnCount"
  | "frameCount"
  | "frameDelayMs"
  | "jpegQuality"
  | "pngCompressionLevel"
  | "webpQuality"
  | "webpLossless"
  | "gifMaxColors"
  | "gifDither";

type GenerateFieldValue = number | string | boolean;

const ALL_GENERATE_FIELD_NAMES: readonly GenerateFieldName[] = [
  "imageWidth",
  "imageHeight",
  "shorterSide",
  "tileRowCount",
  "tileColumnCount",
  "frameCount",
  "frameDelayMs",
  "jpegQuality",
  "pngCompressionLevel",
  "webpQuality",
  "webpLossless",
  "gifMaxColors",
  "gifDither",
];

/**
 * SIZING axis: how many pixels a 'generate' row's output has, keyed by
 * `mediaType:resizingStrategy` for image, `mediaType:outputType` for
 * video. `shorterSide` is deliberately shared by three of the four
 * branches (one output unit's shorter side -- see the type-level doc
 * comment above) -- combined with `ENCODING_FIELDS` below, this is what
 * lets `update()`'s generic per-field carry logic carry it across a
 * `mosaic` <-> `preview` switch, or an `image/resize_shorter_side` <->
 * any video switch, without a field-specific special case.
 */
export const SIZING_FIELDS = {
  "image:fit_to_box": ["imageWidth", "imageHeight"],
  "image:resize_shorter_side": ["shorterSide"],
  "video:mosaic": ["shorterSide", "tileRowCount", "tileColumnCount"],
  "video:preview": ["shorterSide", "frameCount", "frameDelayMs"],
} as const satisfies Record<string, readonly GenerateFieldName[]>;

export type GenerateBranchKey = keyof typeof SIZING_FIELDS;

/**
 * ENCODING axis: how a 'generate' row's pixels are compressed, keyed by
 * `outputMime`, entirely independent of the sizing branch above.
 */
export const ENCODING_FIELDS = {
  "image/jpeg": ["jpegQuality"],
  "image/png": ["pngCompressionLevel"],
  "image/webp": ["webpQuality", "webpLossless"],
  "image/gif": ["gifMaxColors", "gifDither"],
} as const satisfies Record<ThumbnailOutputMime, readonly GenerateFieldName[]>;

/**
 * The one place the two axes meet: which encodings a given sizing branch
 * may legally use. A mosaic (a single still composite) is never `gif` --
 * a one-frame "animation" is strictly worse than any alternative. A
 * preview (always animated) is only ever `gif`/`webp` -- never a still
 * format. An image (either resizing strategy) may be any of the four.
 */
const LEGAL_OUTPUT_MIMES: Record<GenerateBranchKey, readonly ThumbnailOutputMime[]> = {
  "image:fit_to_box": ["image/jpeg", "image/png", "image/webp", "image/gif"],
  "image:resize_shorter_side": ["image/jpeg", "image/png", "image/webp", "image/gif"],
  "video:mosaic": ["image/jpeg", "image/png", "image/webp"],
  "video:preview": ["image/gif", "image/webp"],
};

/** `undefined` for a 'skip' row, or a row missing the second sizing discriminant it needs (caught as a validation error before this is ever consulted for real). */
function sizingKeyFor(
  mediaType: ThumbnailPolicyMediaType | null,
  resizingStrategy: ThumbnailResizingStrategy | null,
  outputType: ThumbnailOutputType | null,
): GenerateBranchKey | undefined {
  if (mediaType === "image" && resizingStrategy) return `image:${resizingStrategy}`;
  if (mediaType === "video" && outputType) return `video:${outputType}`;
  return undefined;
}

function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid policy name "${name}" -- must be non-empty and contain only letters, digits, and underscores`,
    );
  }
}

function validateMimeTypes(mimeTypes: string[]): void {
  if (mimeTypes.length === 0) {
    throw new Error("a thumbnail policy needs at least one mime type");
  }
  for (const mimeType of mimeTypes) {
    if (!MIME_TYPE_PATTERN.test(mimeType)) {
      throw new Error(
        `invalid mime type "${mimeType}" -- expected "type/subtype" or "type/*" (e.g. "image/jpeg", "video/*")`,
      );
    }
  }
}

/**
 * Every `mimeTypes` entry's *type* segment (never wildcarded, only the
 * subtype can be `*` -- see `MIME_TYPE_PATTERN`) must equal `mediaType`.
 * This is what makes a matched policy's `mediaType` **provably** agree
 * with what actually got probed (policy resolution only ever returns a
 * policy whose `mimeTypes` matched the file's real, sniffed mime type) --
 * not just usually-true. Only meaningful for a 'generate' row; a 'skip'
 * row's `mimeTypes` legitimately mixes types (e.g. `["image/*",
 * "video/*"]"`), since matching it never needs a media type at all. Note
 * this is entirely about the *source* mime filter -- unrelated to
 * `outputMime`, which is what a 'generate' row *produces*.
 */
function validateMediaTypeMimeConsistency(
  mediaType: ThumbnailPolicyMediaType,
  mimeTypes: string[],
): void {
  for (const mimeType of mimeTypes) {
    const [type] = mimeType.split("/");
    if (type !== mediaType) {
      throw new Error(
        `mime type "${mimeType}" doesn't match media type "${mediaType}" -- every mime type on a '${mediaType}' policy must be "${mediaType}/..."`,
      );
    }
  }
}

/**
 * Checks the action/media-type/resizing-strategy/output-type/output-mime/
 * generate-fields consistency invariant the `thumbnail_policies` table's
 * own three-way CHECK constraint (sizing, encoding, legality) also
 * enforces, but ahead of time with a friendly, field-naming error message.
 * A 'skip' row must have no media type, no output mime, and none of the
 * thirteen generate-only fields. A 'generate' row must pick a media type,
 * then (for 'image') a `resizingStrategy` or (for 'video') an
 * `outputType` -- together the SIZING branch -- then an `outputMime` legal
 * for that sizing branch (`LEGAL_OUTPUT_MIMES`) -- the ENCODING branch --
 * and carry exactly the union of both branches' own fields
 * (`SIZING_FIELDS` ∪ `ENCODING_FIELDS`) and no others.
 */
function validateActionConsistency(flat: FlatPolicyFields): void {
  if (flat.action === "skip") {
    if (flat.mediaType != null) {
      throw new Error("a 'skip' policy can't have a media type");
    }
    if (flat.outputMime != null) {
      throw new Error("a 'skip' policy can't have an output mime");
    }
    const present = ALL_GENERATE_FIELD_NAMES.filter((name) => flat[name] != null);
    if (present.length > 0) {
      throw new Error(`a 'skip' policy can't set ${present.join(", ")}`);
    }
    return;
  }

  if (flat.mediaType == null) {
    throw new Error("a 'generate' policy needs a media type");
  }
  if (flat.mediaType === "image" && flat.resizingStrategy == null) {
    throw new Error("a 'generate' 'image' policy needs a resizing strategy");
  }
  if (flat.mediaType === "video" && flat.outputType == null) {
    throw new Error("a 'generate' 'video' policy needs an output type");
  }

  const sizingKey = sizingKeyFor(flat.mediaType, flat.resizingStrategy, flat.outputType)!;
  const sizingLabel =
    flat.mediaType === "image"
      ? `'image'/'${flat.resizingStrategy}'`
      : `'video'/'${flat.outputType}'`;

  if (flat.outputMime == null) {
    throw new Error(`a 'generate' ${sizingLabel} policy needs an output mime`);
  }
  const legalMimes = LEGAL_OUTPUT_MIMES[sizingKey];
  if (!legalMimes.includes(flat.outputMime)) {
    throw new Error(
      `a 'generate' ${sizingLabel} policy can't use output mime '${flat.outputMime}' -- must be one of ${legalMimes.join(", ")}`,
    );
  }

  const ownFieldNames = [...SIZING_FIELDS[sizingKey], ...ENCODING_FIELDS[flat.outputMime]];
  const branchLabel = `${sizingLabel}/'${flat.outputMime}'`;

  const missing = ownFieldNames.filter((name) => flat[name] == null);
  if (missing.length > 0) {
    throw new Error(`a 'generate' ${branchLabel} policy needs ${missing.join(", ")}`);
  }

  const present = ALL_GENERATE_FIELD_NAMES.filter(
    (name) => flat[name] != null && !(ownFieldNames as readonly string[]).includes(name),
  );
  if (present.length > 0) {
    throw new Error(`a 'generate' ${branchLabel} policy can't set ${present.join(", ")}`);
  }
}

const ROW_COLUMNS =
  "id, name, glob, action, mime_types, media_type, resizing_strategy, image_width, image_height, " +
  "shorter_side, output_type, tile_row_count, tile_column_count, frame_count, frame_delay_ms, " +
  "output_mime, jpeg_quality, png_compression_level, webp_quality, webp_lossless, " +
  "gif_max_colors, gif_dither, created_at";

interface RawRow {
  id: number;
  name: string;
  glob: string;
  action: ThumbnailPolicyAction;
  mime_types: string;
  media_type: ThumbnailPolicyMediaType | null;
  resizing_strategy: ThumbnailResizingStrategy | null;
  image_width: number | null;
  image_height: number | null;
  shorter_side: number | null;
  output_type: ThumbnailOutputType | null;
  tile_row_count: number | null;
  tile_column_count: number | null;
  frame_count: number | null;
  frame_delay_ms: number | null;
  output_mime: ThumbnailOutputMime | null;
  jpeg_quality: number | null;
  png_compression_level: number | null;
  webp_quality: number | null;
  webp_lossless: number | null;
  gif_max_colors: number | null;
  gif_dither: ThumbnailGifDither | null;
  created_at: string;
}

/**
 * The ENCODING half of a raw row, trusting the table's own CHECK
 * constraint that exactly one branch's fields are non-null for the
 * row's `output_mime` -- same trust-the-database discipline the `!`
 * assertions throughout this file already rely on.
 */
function encodingFromRawRow(row: RawRow): JpegEncoding | PngEncoding | WebpEncoding | GifEncoding {
  switch (row.output_mime) {
    case "image/jpeg":
      return { outputMime: "image/jpeg", jpegQuality: row.jpeg_quality! };
    case "image/png":
      return { outputMime: "image/png", pngCompressionLevel: row.png_compression_level! };
    case "image/webp":
      return {
        outputMime: "image/webp",
        webpQuality: row.webp_quality!,
        webpLossless: row.webp_lossless === 1,
      };
    case "image/gif":
      return {
        outputMime: "image/gif",
        gifMaxColors: row.gif_max_colors!,
        gifDither: row.gif_dither!,
      };
    case null:
      throw new Error(`internal error: 'generate' row ${row.id} has no output_mime`);
  }
}

function fromRawRow(row: RawRow): ThumbnailPolicyRow {
  const base: Base = {
    id: row.id,
    name: row.name,
    glob: row.glob,
    mimeTypes: JSON.parse(row.mime_types) as string[],
    createdAt: row.created_at,
  };

  if (row.action === "skip") {
    return { ...base, action: "skip" };
  }

  const encoding = encodingFromRawRow(row);

  // Non-null assertions below rely on the table's own sizing CHECK
  // constraint: a 'generate' row's branch-appropriate sizing fields are
  // always NOT NULL, never on trust alone. The `as ThumbnailPolicyRow`
  // casts on the video branches exist because `encoding`'s own type is
  // the full 4-arm union (TS can't statically know `LEGAL_OUTPUT_MIMES`
  // already ruled out e.g. gif-for-mosaic here) -- the table's legality
  // CHECK is what actually guarantees it at runtime.
  if (row.media_type === "image") {
    if (row.resizing_strategy === "fit_to_box") {
      return {
        ...base,
        action: "generate",
        mediaType: "image",
        resizingStrategy: "fit_to_box",
        imageWidth: row.image_width!,
        imageHeight: row.image_height!,
        ...encoding,
      };
    }
    // resizing_strategy === "resize_shorter_side" -- the CHECK constraint
    // leaves no other possibility for a 'generate'+'image' row.
    return {
      ...base,
      action: "generate",
      mediaType: "image",
      resizingStrategy: "resize_shorter_side",
      shorterSide: row.shorter_side!,
      ...encoding,
    };
  }
  // media_type === "video"
  if (row.output_type === "mosaic") {
    return {
      ...base,
      action: "generate",
      mediaType: "video",
      outputType: "mosaic",
      shorterSide: row.shorter_side!,
      tileRowCount: row.tile_row_count!,
      tileColumnCount: row.tile_column_count!,
      ...encoding,
    } as ThumbnailPolicyRow;
  }
  // output_type === "preview" -- the CHECK constraint leaves no other
  // possibility for a 'generate'+'video' row.
  return {
    ...base,
    action: "generate",
    mediaType: "video",
    outputType: "preview",
    shorterSide: row.shorter_side!,
    frameCount: row.frame_count!,
    frameDelayMs: row.frame_delay_ms!,
    ...encoding,
  } as ThumbnailPolicyRow;
}

/** The ENCODING half of an already-narrowed row, inverse of `encodingFromRawRow`. */
function flatEncodingFrom(
  row: ThumbnailPolicyGenerateRow,
): Pick<
  FlatPolicyFields,
  | "outputMime"
  | "jpegQuality"
  | "pngCompressionLevel"
  | "webpQuality"
  | "webpLossless"
  | "gifMaxColors"
  | "gifDither"
> {
  const empty = {
    jpegQuality: null,
    pngCompressionLevel: null,
    webpQuality: null,
    webpLossless: null,
    gifMaxColors: null,
    gifDither: null,
  };
  switch (row.outputMime) {
    case "image/jpeg":
      return { ...empty, outputMime: "image/jpeg", jpegQuality: row.jpegQuality };
    case "image/png":
      return { ...empty, outputMime: "image/png", pngCompressionLevel: row.pngCompressionLevel };
    case "image/webp":
      return {
        ...empty,
        outputMime: "image/webp",
        webpQuality: row.webpQuality,
        webpLossless: row.webpLossless,
      };
    case "image/gif":
      return {
        ...empty,
        outputMime: "image/gif",
        gifMaxColors: row.gifMaxColors,
        gifDither: row.gifDither,
      };
  }
}

/** The inverse of `fromRawRow`'s narrowing -- flattens a validated row back to the all-nullable shape `update()`'s merge and the SQL layer both need. */
function toFlatFields(row: ThumbnailPolicyRow): FlatPolicyFields {
  const base = { name: row.name, glob: row.glob, mimeTypes: row.mimeTypes };
  const empty: Omit<FlatPolicyFields, keyof typeof base | "action"> = {
    mediaType: null,
    resizingStrategy: null,
    imageWidth: null,
    imageHeight: null,
    shorterSide: null,
    outputType: null,
    tileRowCount: null,
    tileColumnCount: null,
    frameCount: null,
    frameDelayMs: null,
    outputMime: null,
    jpegQuality: null,
    pngCompressionLevel: null,
    webpQuality: null,
    webpLossless: null,
    gifMaxColors: null,
    gifDither: null,
  };

  if (row.action === "skip") {
    return { ...base, ...empty, action: "skip" };
  }

  const encoding = flatEncodingFrom(row);

  if (row.mediaType === "image" && row.resizingStrategy === "fit_to_box") {
    return {
      ...base,
      ...empty,
      ...encoding,
      action: "generate",
      mediaType: "image",
      resizingStrategy: "fit_to_box",
      imageWidth: row.imageWidth,
      imageHeight: row.imageHeight,
    };
  }
  if (row.mediaType === "image") {
    return {
      ...base,
      ...empty,
      ...encoding,
      action: "generate",
      mediaType: "image",
      resizingStrategy: "resize_shorter_side",
      shorterSide: row.shorterSide,
    };
  }
  if (row.outputType === "mosaic") {
    return {
      ...base,
      ...empty,
      ...encoding,
      action: "generate",
      mediaType: "video",
      outputType: "mosaic",
      shorterSide: row.shorterSide,
      tileRowCount: row.tileRowCount,
      tileColumnCount: row.tileColumnCount,
    };
  }
  return {
    ...base,
    ...empty,
    ...encoding,
    action: "generate",
    mediaType: "video",
    outputType: "preview",
    shorterSide: row.shorterSide,
    frameCount: row.frameCount,
    frameDelayMs: row.frameDelayMs,
  };
}

/**
 * Reads every possible field directly off `input`, not only the ones the
 * real `ThumbnailPolicyCreateInput` union guarantees for its narrowed
 * branch -- a legitimate, type-checked caller never has a field from the
 * wrong branch to begin with, but this keeps `validateActionConsistency`
 * (below) a genuine runtime safety net too, not just a compile-time one,
 * for a caller that sidesteps the type (e.g. plain JS, or an explicit
 * cast). Silently dropping an unexpected field here instead would defeat
 * that safety net rather than exercise it.
 */
function flatFromCreateInput(input: ThumbnailPolicyCreateInput): FlatPolicyFields {
  const loose = input as unknown as Partial<FlatPolicyFields>;
  return {
    name: input.name,
    glob: input.glob,
    action: input.action,
    mimeTypes: input.mimeTypes,
    mediaType: loose.mediaType ?? null,
    resizingStrategy: loose.resizingStrategy ?? null,
    imageWidth: loose.imageWidth ?? null,
    imageHeight: loose.imageHeight ?? null,
    shorterSide: loose.shorterSide ?? null,
    outputType: loose.outputType ?? null,
    tileRowCount: loose.tileRowCount ?? null,
    tileColumnCount: loose.tileColumnCount ?? null,
    frameCount: loose.frameCount ?? null,
    frameDelayMs: loose.frameDelayMs ?? null,
    outputMime: loose.outputMime ?? null,
    jpegQuality: loose.jpegQuality ?? null,
    pngCompressionLevel: loose.pngCompressionLevel ?? null,
    webpQuality: loose.webpQuality ?? null,
    webpLossless: loose.webpLossless ?? null,
    gifMaxColors: loose.gifMaxColors ?? null,
    gifDither: loose.gifDither ?? null,
  };
}

/** `better-sqlite3` doesn't accept JS booleans as bind parameters -- stored/read as an INTEGER 0/1, converted at this repository's own boundary so every other layer works with a real `boolean`. */
function boolToSqlInt(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

/**
 * state.db's `thumbnail_policies` table -- global, versioned, shared across
 * every machine. Unlike `storage_policies`, there is no mandatory default
 * row: a path matching no policy glob at all is simply not a thumbnail
 * candidate. Unlike `storage_policies`, there is also no priority: every
 * matching 'generate' policy produces its own thumbnail (a 'skip' match
 * still vetoes all of them) -- see docs/architecture/thumbnails.md.
 */
export class ThumbnailPoliciesRepository {
  constructor(private readonly db: Database.Database) {}

  list(): ThumbnailPolicyRow[] {
    return this.db
      .prepare<[], RawRow>(`SELECT ${ROW_COLUMNS} FROM thumbnail_policies ORDER BY id ASC`)
      .all()
      .map(fromRawRow);
  }

  get(id: number): ThumbnailPolicyRow | undefined {
    const row = this.db
      .prepare<[number], RawRow>(`SELECT ${ROW_COLUMNS} FROM thumbnail_policies WHERE id = ?`)
      .get(id);
    return row ? fromRawRow(row) : undefined;
  }

  /** Every 'generate' row -- what thumbnail-policy resolution filters (every match generates, so there's no ordering to apply). */
  listGenerate(): ThumbnailPolicyRow[] {
    return this.db
      .prepare<[], RawRow>(
        `SELECT ${ROW_COLUMNS} FROM thumbnail_policies WHERE action = 'generate' ORDER BY id ASC`,
      )
      .all()
      .map(fromRawRow);
  }

  /** Every 'skip' row -- matching any one of these wins outright, no priority ordering needed. */
  listSkip(): ThumbnailPolicyRow[] {
    return this.db
      .prepare<[], RawRow>(`SELECT ${ROW_COLUMNS} FROM thumbnail_policies WHERE action = 'skip'`)
      .all()
      .map(fromRawRow);
  }

  create(input: ThumbnailPolicyCreateInput): number {
    const flat = flatFromCreateInput(input);
    validateName(flat.name);
    validateActionConsistency(flat);
    validateMimeTypes(flat.mimeTypes);
    if (flat.mediaType) validateMediaTypeMimeConsistency(flat.mediaType, flat.mimeTypes);

    const result = this.db
      .prepare<
        [
          string,
          string,
          ThumbnailPolicyAction,
          string,
          ThumbnailPolicyMediaType | null,
          ThumbnailResizingStrategy | null,
          number | null,
          number | null,
          number | null,
          ThumbnailOutputType | null,
          number | null,
          number | null,
          number | null,
          number | null,
          ThumbnailOutputMime | null,
          number | null,
          number | null,
          number | null,
          number | null,
          number | null,
          ThumbnailGifDither | null,
          string,
        ]
      >(
        `INSERT INTO thumbnail_policies (
          name, glob, action, mime_types, media_type, resizing_strategy, image_width, image_height,
          shorter_side, output_type, tile_row_count, tile_column_count, frame_count, frame_delay_ms,
          output_mime, jpeg_quality, png_compression_level, webp_quality, webp_lossless,
          gif_max_colors, gif_dither, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        flat.name,
        flat.glob,
        flat.action,
        JSON.stringify(flat.mimeTypes),
        flat.mediaType,
        flat.resizingStrategy,
        flat.imageWidth,
        flat.imageHeight,
        flat.shorterSide,
        flat.outputType,
        flat.tileRowCount,
        flat.tileColumnCount,
        flat.frameCount,
        flat.frameDelayMs,
        flat.outputMime,
        flat.jpegQuality,
        flat.pngCompressionLevel,
        flat.webpQuality,
        boolToSqlInt(flat.webpLossless),
        flat.gifMaxColors,
        flat.gifDither,
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Applies a partial update, merging onto the existing row and
   * re-validating the resulting whole. Returns `false` for a nonexistent
   * id.
   *
   * A field carries over from the existing row only if the *new* branch
   * (after applying `action`/`mediaType`/`resizingStrategy`/`outputType`/
   * `outputMime` from `changes`) also has that field in its own set
   * (`SIZING_FIELDS` ∪ `ENCODING_FIELDS`) -- otherwise it's forced to
   * `null`, regardless of what the old row had. This one rule handles
   * every case uniformly, including the fields shared across branches:
   * `shorterSide` (every branch but `fit_to_box`) carries across a
   * `mosaic` <-> `preview` switch or an `image/resize_shorter_side` <->
   * any video switch; `jpegQuality`/`pngCompressionLevel`/`webpQuality`/
   * `webpLossless`/`gifMaxColors`/`gifDither` each carry across any
   * switch that leaves `outputMime` unchanged (e.g. `fit_to_box` <->
   * `resize_shorter_side` with the same `outputMime`). None of this needs
   * a field-specific special case, because `old[name]` is already `null`
   * for a field the *old* branch didn't have -- so "carry `old[name]`
   * forward when the new branch wants this field" degrades correctly to
   * "nothing to carry" when the old branch never had it either.
   */
  update(id: number, changes: ThumbnailPolicyUpdate): boolean {
    const row = this.get(id);
    if (!row) return false;
    const old = toFlatFields(row);

    const action = changes.action ?? old.action;
    const name = changes.name ?? old.name;
    const glob = changes.glob ?? old.glob;
    const mimeTypes = changes.mimeTypes ?? old.mimeTypes;
    const mediaType =
      action === "generate"
        ? (changes.mediaType ?? (old.action === "generate" ? old.mediaType : null))
        : null;
    const resizingStrategy =
      action === "generate" && mediaType === "image"
        ? (changes.resizingStrategy ?? (old.mediaType === "image" ? old.resizingStrategy : null))
        : null;
    const outputType =
      action === "generate" && mediaType === "video"
        ? (changes.outputType ?? (old.mediaType === "video" ? old.outputType : null))
        : null;
    const outputMime =
      action === "generate"
        ? (changes.outputMime ?? (old.action === "generate" ? old.outputMime : null))
        : null;

    const sizingKey = sizingKeyFor(mediaType, resizingStrategy, outputType);
    const newFieldNames: readonly GenerateFieldName[] = [
      ...(sizingKey ? SIZING_FIELDS[sizingKey] : []),
      ...(outputMime ? ENCODING_FIELDS[outputMime] : []),
    ];

    const field = (fieldName: GenerateFieldName): GenerateFieldValue | null => {
      const changeValue = changes[fieldName];
      if (changeValue !== undefined) return changeValue;
      if (!newFieldNames.includes(fieldName)) return null;
      return old[fieldName];
    };

    const flat: FlatPolicyFields = {
      name,
      glob,
      action,
      mimeTypes,
      mediaType,
      resizingStrategy,
      outputType,
      outputMime,
      imageWidth: field("imageWidth") as number | null,
      imageHeight: field("imageHeight") as number | null,
      shorterSide: field("shorterSide") as number | null,
      tileRowCount: field("tileRowCount") as number | null,
      tileColumnCount: field("tileColumnCount") as number | null,
      frameCount: field("frameCount") as number | null,
      frameDelayMs: field("frameDelayMs") as number | null,
      jpegQuality: field("jpegQuality") as number | null,
      pngCompressionLevel: field("pngCompressionLevel") as number | null,
      webpQuality: field("webpQuality") as number | null,
      webpLossless: field("webpLossless") as boolean | null,
      gifMaxColors: field("gifMaxColors") as number | null,
      gifDither: field("gifDither") as ThumbnailGifDither | null,
    };

    validateName(flat.name);
    validateActionConsistency(flat);
    validateMimeTypes(flat.mimeTypes);
    if (flat.mediaType) validateMediaTypeMimeConsistency(flat.mediaType, flat.mimeTypes);

    const result = this.db
      .prepare<
        [
          string,
          string,
          ThumbnailPolicyAction,
          string,
          ThumbnailPolicyMediaType | null,
          ThumbnailResizingStrategy | null,
          number | null,
          number | null,
          number | null,
          ThumbnailOutputType | null,
          number | null,
          number | null,
          number | null,
          number | null,
          ThumbnailOutputMime | null,
          number | null,
          number | null,
          number | null,
          number | null,
          number | null,
          ThumbnailGifDither | null,
          number,
        ]
      >(
        `UPDATE thumbnail_policies SET
          name = ?, glob = ?, action = ?, mime_types = ?, media_type = ?, resizing_strategy = ?,
          image_width = ?, image_height = ?, shorter_side = ?, output_type = ?, tile_row_count = ?,
          tile_column_count = ?, frame_count = ?, frame_delay_ms = ?, output_mime = ?, jpeg_quality = ?,
          png_compression_level = ?, webp_quality = ?, webp_lossless = ?, gif_max_colors = ?, gif_dither = ?
        WHERE id = ?`,
      )
      .run(
        flat.name,
        flat.glob,
        flat.action,
        JSON.stringify(flat.mimeTypes),
        flat.mediaType,
        flat.resizingStrategy,
        flat.imageWidth,
        flat.imageHeight,
        flat.shorterSide,
        flat.outputType,
        flat.tileRowCount,
        flat.tileColumnCount,
        flat.frameCount,
        flat.frameDelayMs,
        flat.outputMime,
        flat.jpegQuality,
        flat.pngCompressionLevel,
        flat.webpQuality,
        boolToSqlInt(flat.webpLossless),
        flat.gifMaxColors,
        flat.gifDither,
        id,
      );
    return result.changes > 0;
  }

  delete(id: number): boolean {
    const result = this.db.prepare<[number]>("DELETE FROM thumbnail_policies WHERE id = ?").run(id);
    return result.changes > 0;
  }
}
