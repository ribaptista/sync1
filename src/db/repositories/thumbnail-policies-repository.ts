import type Database from "better-sqlite3";

export type ThumbnailPolicyAction = "skip" | "generate";
export type ThumbnailPolicyMediaType = "image" | "video";
export type ThumbnailResizingStrategy = "fit_to_box" | "resize_shorter_side";
export type ThumbnailOutputType = "mosaic" | "gif";

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
 * Flat, not nested: every existing consumer reads a field like
 * `policy.imageWidth` or `policy.tileSize` directly, and nesting a
 * `generate: {...}` sub-object would force an `if (policy.action ===
 * "generate")` unwrap everywhere for no safety gain over the discriminants
 * already living on `action`/`mediaType`/`resizingStrategy`/`outputType`.
 * A 'skip' row carries none of them. A 'generate' row is exactly one of
 * four branches -- an image policy picks a `resizingStrategy` (which
 * fields apply), a video policy picks an `outputType` (which fields
 * apply) -- never fields from a branch it isn't. `tileSize` is the one
 * field 'mosaic' and 'gif' share (frame/tile shorter-side target);
 * `jpegQuality` is the one field every branch *except* 'gif' has (a GIF
 * is never JPEG-encoded).
 */
export type ThumbnailPolicyRow =
  | (Base & { action: "skip" })
  | (Base & {
      action: "generate";
      mediaType: "image";
      resizingStrategy: "fit_to_box";
      imageWidth: number;
      imageHeight: number;
      jpegQuality: number;
    })
  | (Base & {
      action: "generate";
      mediaType: "image";
      resizingStrategy: "resize_shorter_side";
      shorterSide: number;
      jpegQuality: number;
    })
  | (Base & {
      action: "generate";
      mediaType: "video";
      outputType: "mosaic";
      tileRowCount: number;
      tileColumnCount: number;
      tileSize: number;
      jpegQuality: number;
    })
  | (Base & {
      action: "generate";
      mediaType: "video";
      outputType: "gif";
      tileSize: number;
      frameCount: number;
      frameDelayMs: number;
    });

/** What a policy match actually is -- a 'skip' row is never useful past the fact that it matched. */
export type ThumbnailPolicyGenerateRow = Extract<ThumbnailPolicyRow, { action: "generate" }>;

export type ThumbnailPolicyCreateInput =
  | { name: string; glob: string; action: "skip"; mimeTypes: string[] }
  | {
      name: string;
      glob: string;
      action: "generate";
      mediaType: "image";
      resizingStrategy: "fit_to_box";
      mimeTypes: string[];
      imageWidth: number;
      imageHeight: number;
      jpegQuality: number;
    }
  | {
      name: string;
      glob: string;
      action: "generate";
      mediaType: "image";
      resizingStrategy: "resize_shorter_side";
      mimeTypes: string[];
      shorterSide: number;
      jpegQuality: number;
    }
  | {
      name: string;
      glob: string;
      action: "generate";
      mediaType: "video";
      outputType: "mosaic";
      mimeTypes: string[];
      tileRowCount: number;
      tileColumnCount: number;
      tileSize: number;
      jpegQuality: number;
    }
  | {
      name: string;
      glob: string;
      action: "generate";
      mediaType: "video";
      outputType: "gif";
      mimeTypes: string[];
      tileSize: number;
      frameCount: number;
      frameDelayMs: number;
    };

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
  tileSize?: number;
  frameCount?: number;
  frameDelayMs?: number;
  jpegQuality?: number;
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
  tileSize: number | null;
  frameCount: number | null;
  frameDelayMs: number | null;
  jpegQuality: number | null;
}

export type GenerateFieldName =
  | "imageWidth"
  | "imageHeight"
  | "shorterSide"
  | "tileRowCount"
  | "tileColumnCount"
  | "tileSize"
  | "frameCount"
  | "frameDelayMs"
  | "jpegQuality";

const ALL_GENERATE_FIELD_NAMES: readonly GenerateFieldName[] = [
  "imageWidth",
  "imageHeight",
  "shorterSide",
  "tileRowCount",
  "tileColumnCount",
  "tileSize",
  "frameCount",
  "frameDelayMs",
  "jpegQuality",
];

/**
 * A 'generate' row is exactly one of these four branches -- keyed by
 * `mediaType:resizingStrategy` for image, `mediaType:outputType` for
 * video. Each branch's field list is exactly what that branch requires;
 * everything else in `ALL_GENERATE_FIELD_NAMES` is forbidden for it. Two
 * fields are deliberately shared across branches -- `tileSize` (mosaic
 * and gif: one tile's / one frame's shorter side) and `jpegQuality`
 * (every branch except gif) -- which is also what lets `update()`'s
 * generic per-field carry logic (below) carry them across a branch switch
 * without a field-specific special case.
 */
export const GENERATE_BRANCH_FIELDS = {
  "image:fit_to_box": ["imageWidth", "imageHeight", "jpegQuality"],
  "image:resize_shorter_side": ["shorterSide", "jpegQuality"],
  "video:mosaic": ["tileRowCount", "tileColumnCount", "tileSize", "jpegQuality"],
  "video:gif": ["tileSize", "frameCount", "frameDelayMs"],
} as const satisfies Record<string, readonly GenerateFieldName[]>;

export type GenerateBranchKey = keyof typeof GENERATE_BRANCH_FIELDS;

/** `undefined` for a 'skip' row, or a row missing the second discriminant it needs (caught as a validation error before this is ever consulted for real). */
function branchKeyFor(
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
 * "video/*"]"`), since matching it never needs a media type at all.
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
 * Checks the action/media-type/resizing-strategy/output-type/generate-
 * fields consistency invariant the `thumbnail_policies` table's own
 * five-way CHECK constraint also enforces, but ahead of time with a
 * friendly, field-naming error message. A 'skip' row must have no media
 * type and none of the nine generate-only fields. A 'generate' row must
 * pick a media type, then (for 'image') a `resizingStrategy` or (for
 * 'video') an `outputType`, and carry exactly that branch's own fields
 * (`GENERATE_BRANCH_FIELDS`) and no others.
 */
function validateActionConsistency(flat: FlatPolicyFields): void {
  if (flat.action === "skip") {
    if (flat.mediaType != null) {
      throw new Error("a 'skip' policy can't have a media type");
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

  const branchKey = branchKeyFor(flat.mediaType, flat.resizingStrategy, flat.outputType)!;
  const ownFieldNames = GENERATE_BRANCH_FIELDS[branchKey];
  const branchLabel =
    flat.mediaType === "image"
      ? `'image'/'${flat.resizingStrategy}'`
      : `'video'/'${flat.outputType}'`;

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
  "shorter_side, output_type, tile_row_count, tile_column_count, tile_size, frame_count, " +
  "frame_delay_ms, jpeg_quality, created_at";

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
  tile_size: number | null;
  frame_count: number | null;
  frame_delay_ms: number | null;
  jpeg_quality: number | null;
  created_at: string;
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

  // Non-null assertions below rely on the table's own five-way CHECK
  // constraint: a 'generate' row's branch-appropriate fields are always
  // NOT NULL, never on trust alone.
  if (row.media_type === "image") {
    if (row.resizing_strategy === "fit_to_box") {
      return {
        ...base,
        action: "generate",
        mediaType: "image",
        resizingStrategy: "fit_to_box",
        imageWidth: row.image_width!,
        imageHeight: row.image_height!,
        jpegQuality: row.jpeg_quality!,
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
      jpegQuality: row.jpeg_quality!,
    };
  }
  // media_type === "video"
  if (row.output_type === "mosaic") {
    return {
      ...base,
      action: "generate",
      mediaType: "video",
      outputType: "mosaic",
      tileRowCount: row.tile_row_count!,
      tileColumnCount: row.tile_column_count!,
      tileSize: row.tile_size!,
      jpegQuality: row.jpeg_quality!,
    };
  }
  // output_type === "gif" -- the CHECK constraint leaves no other
  // possibility for a 'generate'+'video' row.
  return {
    ...base,
    action: "generate",
    mediaType: "video",
    outputType: "gif",
    tileSize: row.tile_size!,
    frameCount: row.frame_count!,
    frameDelayMs: row.frame_delay_ms!,
  };
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
    tileSize: null,
    frameCount: null,
    frameDelayMs: null,
    jpegQuality: null,
  };

  if (row.action === "skip") {
    return { ...base, ...empty, action: "skip" };
  }
  if (row.mediaType === "image" && row.resizingStrategy === "fit_to_box") {
    return {
      ...base,
      ...empty,
      action: "generate",
      mediaType: "image",
      resizingStrategy: "fit_to_box",
      imageWidth: row.imageWidth,
      imageHeight: row.imageHeight,
      jpegQuality: row.jpegQuality,
    };
  }
  if (row.mediaType === "image") {
    return {
      ...base,
      ...empty,
      action: "generate",
      mediaType: "image",
      resizingStrategy: "resize_shorter_side",
      shorterSide: row.shorterSide,
      jpegQuality: row.jpegQuality,
    };
  }
  if (row.outputType === "mosaic") {
    return {
      ...base,
      ...empty,
      action: "generate",
      mediaType: "video",
      outputType: "mosaic",
      tileRowCount: row.tileRowCount,
      tileColumnCount: row.tileColumnCount,
      tileSize: row.tileSize,
      jpegQuality: row.jpegQuality,
    };
  }
  return {
    ...base,
    ...empty,
    action: "generate",
    mediaType: "video",
    outputType: "gif",
    tileSize: row.tileSize,
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
    tileSize: loose.tileSize ?? null,
    frameCount: loose.frameCount ?? null,
    frameDelayMs: loose.frameDelayMs ?? null,
    jpegQuality: loose.jpegQuality ?? null,
  };
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
          number | null,
          number | null,
          string,
        ]
      >(
        `INSERT INTO thumbnail_policies (
          name, glob, action, mime_types, media_type, resizing_strategy, image_width, image_height,
          shorter_side, output_type, tile_row_count, tile_column_count, tile_size, frame_count,
          frame_delay_ms, jpeg_quality, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        flat.tileSize,
        flat.frameCount,
        flat.frameDelayMs,
        flat.jpegQuality,
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
   * (after applying `action`/`mediaType`/`resizingStrategy`/`outputType`
   * from `changes`) also has that field in its own set
   * (`GENERATE_BRANCH_FIELDS`) -- otherwise it's forced to `null`,
   * regardless of what the old row had. This one rule handles every case
   * uniformly, including the two fields shared across branches:
   * `jpegQuality` (every branch but 'gif') and `tileSize` ('mosaic' and
   * 'gif') both carry across a switch between their shared branches
   * without needing a field-specific special case, because `old[name]`
   * is already `null` for a field the *old* branch didn't have -- so
   * "carry `old[name]` forward when the new branch wants this field"
   * degrades correctly to "nothing to carry" when the old branch never
   * had it either.
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

    const newBranchKey = branchKeyFor(mediaType, resizingStrategy, outputType);
    const newBranchFields: readonly GenerateFieldName[] = newBranchKey
      ? GENERATE_BRANCH_FIELDS[newBranchKey]
      : [];

    const field = (fieldName: GenerateFieldName): number | null => {
      if (changes[fieldName] !== undefined) return changes[fieldName];
      if (!newBranchFields.includes(fieldName)) return null;
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
      imageWidth: field("imageWidth"),
      imageHeight: field("imageHeight"),
      shorterSide: field("shorterSide"),
      tileRowCount: field("tileRowCount"),
      tileColumnCount: field("tileColumnCount"),
      tileSize: field("tileSize"),
      frameCount: field("frameCount"),
      frameDelayMs: field("frameDelayMs"),
      jpegQuality: field("jpegQuality"),
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
          number | null,
          number | null,
          number,
        ]
      >(
        `UPDATE thumbnail_policies SET
          name = ?, glob = ?, action = ?, mime_types = ?, media_type = ?, resizing_strategy = ?,
          image_width = ?, image_height = ?, shorter_side = ?, output_type = ?, tile_row_count = ?,
          tile_column_count = ?, tile_size = ?, frame_count = ?, frame_delay_ms = ?, jpeg_quality = ?
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
        flat.tileSize,
        flat.frameCount,
        flat.frameDelayMs,
        flat.jpegQuality,
        id,
      );
    return result.changes > 0;
  }

  delete(id: number): boolean {
    const result = this.db.prepare<[number]>("DELETE FROM thumbnail_policies WHERE id = ?").run(id);
    return result.changes > 0;
  }
}
