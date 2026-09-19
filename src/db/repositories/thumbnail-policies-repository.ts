import type Database from "better-sqlite3";

export type ThumbnailPolicyAction = "skip" | "generate";
export type ThumbnailPolicyMediaType = "image" | "video";

const MIME_TYPE_PATTERN = /^[a-zA-Z0-9.+-]+\/(\*|[a-zA-Z0-9.+-]+)$/;

interface Base {
  id: number;
  glob: string;
  mimeTypes: string[];
  createdAt: string;
}

/**
 * Flat, not nested: every existing consumer reads a field like
 * `policy.imageWidth` or `policy.tileSize` directly, and nesting a
 * `generate: {...}` sub-object would force an `if (policy.action ===
 * "generate")` unwrap everywhere for no safety gain over the discriminant
 * already living on `action`/`mediaType`. A 'skip' row carries no
 * `mediaType` at all (never applicable); a 'generate' row is *either* an
 * image policy or a video policy, never both -- no more nonsense tile
 * fields on an image-only policy, no more `!` non-null assertions
 * scattered through consuming code.
 */
export type ThumbnailPolicyRow =
  | (Base & { action: "skip"; priority: null })
  | (Base & {
      action: "generate";
      mediaType: "image";
      priority: number;
      imageWidth: number;
      imageHeight: number;
      jpegQuality: number;
    })
  | (Base & {
      action: "generate";
      mediaType: "video";
      priority: number;
      tileRowCount: number;
      tileColumnCount: number;
      tileSize: number;
      jpegQuality: number;
    });

/** What a `resolvePolicy` match actually is -- a 'skip' row is never useful past the fact that it matched. */
export type ThumbnailPolicyGenerateRow = Extract<ThumbnailPolicyRow, { action: "generate" }>;

export type ThumbnailPolicyCreateInput =
  | { glob: string; action: "skip"; mimeTypes: string[] }
  | {
      glob: string;
      action: "generate";
      mediaType: "image";
      mimeTypes: string[];
      priority?: number;
      imageWidth: number;
      imageHeight: number;
      jpegQuality: number;
    }
  | {
      glob: string;
      action: "generate";
      mediaType: "video";
      mimeTypes: string[];
      priority?: number;
      tileRowCount: number;
      tileColumnCount: number;
      tileSize: number;
      jpegQuality: number;
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
  glob?: string;
  action?: ThumbnailPolicyAction;
  mimeTypes?: string[];
  priority?: number;
  mediaType?: ThumbnailPolicyMediaType;
  imageWidth?: number;
  imageHeight?: number;
  tileRowCount?: number;
  tileColumnCount?: number;
  tileSize?: number;
  jpegQuality?: number;
}

/** The all-nullable shape both the SQL layer and `update()`'s merge work in -- every field a row could possibly have, regardless of which branch is actually live. */
interface FlatPolicyFields {
  glob: string;
  action: ThumbnailPolicyAction;
  priority: number | null;
  mimeTypes: string[];
  mediaType: ThumbnailPolicyMediaType | null;
  imageWidth: number | null;
  imageHeight: number | null;
  tileRowCount: number | null;
  tileColumnCount: number | null;
  tileSize: number | null;
  jpegQuality: number | null;
}

type TypeSpecificFieldName =
  "imageWidth" | "imageHeight" | "tileRowCount" | "tileColumnCount" | "tileSize";

const IMAGE_FIELD_NAMES = ["imageWidth", "imageHeight"] as const;
const VIDEO_FIELD_NAMES = ["tileRowCount", "tileColumnCount", "tileSize"] as const;

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
 * This is what makes a `resolvePolicy`-selected policy's `mediaType`
 * **provably** agree with what actually got probed (`resolvePolicy` only
 * ever returns a policy whose `mimeTypes` matched the file's real, sniffed
 * mime type) -- not just usually-true. Only meaningful for a 'generate'
 * row; a 'skip' row's `mimeTypes` legitimately mixes types (e.g.
 * `["image/*", "video/*"]"`), since matching it never needs a media type
 * at all.
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
 * Checks the action/priority/media-type/generate-fields consistency
 * invariant the `thumbnail_policies` table's own three-way CHECK
 * constraint also enforces, but ahead of time with a friendly, field-
 * naming error message. A 'skip' row must have no priority, no media
 * type, and none of the six generate fields at all. A 'generate' row must
 * have a priority and a media type; given that media type, it must have
 * every field belonging to its own type (image fields ∪ jpegQuality, or
 * video fields ∪ jpegQuality) and none of the other type's fields.
 */
function validateActionConsistency(flat: FlatPolicyFields): void {
  if (flat.action === "skip") {
    if (flat.priority != null) {
      throw new Error("a 'skip' policy can't have a priority");
    }
    if (flat.mediaType != null) {
      throw new Error("a 'skip' policy can't have a media type");
    }
    const present = [...IMAGE_FIELD_NAMES, ...VIDEO_FIELD_NAMES, "jpegQuality" as const].filter(
      (name) => flat[name] != null,
    );
    if (present.length > 0) {
      throw new Error(`a 'skip' policy can't set ${present.join(", ")}`);
    }
    return;
  }

  if (flat.priority == null) {
    throw new Error("a 'generate' policy needs a priority");
  }
  if (flat.mediaType == null) {
    throw new Error("a 'generate' policy needs a media type");
  }

  const [ownFieldNames, otherFieldNames] =
    flat.mediaType === "image"
      ? [IMAGE_FIELD_NAMES, VIDEO_FIELD_NAMES]
      : [VIDEO_FIELD_NAMES, IMAGE_FIELD_NAMES];

  const missing = [...ownFieldNames, "jpegQuality" as const].filter((name) => flat[name] == null);
  if (missing.length > 0) {
    throw new Error(`a 'generate' '${flat.mediaType}' policy needs ${missing.join(", ")}`);
  }

  const present = otherFieldNames.filter((name) => flat[name] != null);
  if (present.length > 0) {
    throw new Error(`a 'generate' '${flat.mediaType}' policy can't set ${present.join(", ")}`);
  }
}

const ROW_COLUMNS =
  "id, glob, action, priority, mime_types, media_type, image_width, image_height, " +
  "tile_row_count, tile_column_count, tile_size, jpeg_quality, created_at";

interface RawRow {
  id: number;
  glob: string;
  action: ThumbnailPolicyAction;
  priority: number | null;
  mime_types: string;
  media_type: ThumbnailPolicyMediaType | null;
  image_width: number | null;
  image_height: number | null;
  tile_row_count: number | null;
  tile_column_count: number | null;
  tile_size: number | null;
  jpeg_quality: number | null;
  created_at: string;
}

function fromRawRow(row: RawRow): ThumbnailPolicyRow {
  const base: Base = {
    id: row.id,
    glob: row.glob,
    mimeTypes: JSON.parse(row.mime_types) as string[],
    createdAt: row.created_at,
  };

  if (row.action === "skip") {
    return { ...base, action: "skip", priority: null };
  }

  // Non-null assertions below rely on the table's own three-way CHECK
  // constraint: a 'generate' row's media-type-appropriate fields (plus
  // priority and jpegQuality) are always NOT NULL, never on trust alone.
  if (row.media_type === "image") {
    return {
      ...base,
      action: "generate",
      mediaType: "image",
      priority: row.priority!,
      imageWidth: row.image_width!,
      imageHeight: row.image_height!,
      jpegQuality: row.jpeg_quality!,
    };
  }
  // media_type === "video" -- the CHECK constraint leaves no other
  // possibility for a 'generate' row.
  return {
    ...base,
    action: "generate",
    mediaType: "video",
    priority: row.priority!,
    tileRowCount: row.tile_row_count!,
    tileColumnCount: row.tile_column_count!,
    tileSize: row.tile_size!,
    jpegQuality: row.jpeg_quality!,
  };
}

/** The inverse of `fromRawRow`'s narrowing -- flattens a validated row back to the all-nullable shape `update()`'s merge and the SQL layer both need. */
function toFlatFields(row: ThumbnailPolicyRow): FlatPolicyFields {
  const base = { glob: row.glob, mimeTypes: row.mimeTypes };
  if (row.action === "skip") {
    return {
      ...base,
      action: "skip",
      priority: null,
      mediaType: null,
      imageWidth: null,
      imageHeight: null,
      tileRowCount: null,
      tileColumnCount: null,
      tileSize: null,
      jpegQuality: null,
    };
  }
  if (row.mediaType === "image") {
    return {
      ...base,
      action: "generate",
      priority: row.priority,
      mediaType: "image",
      imageWidth: row.imageWidth,
      imageHeight: row.imageHeight,
      tileRowCount: null,
      tileColumnCount: null,
      tileSize: null,
      jpegQuality: row.jpegQuality,
    };
  }
  return {
    ...base,
    action: "generate",
    priority: row.priority,
    mediaType: "video",
    imageWidth: null,
    imageHeight: null,
    tileRowCount: row.tileRowCount,
    tileColumnCount: row.tileColumnCount,
    tileSize: row.tileSize,
    jpegQuality: row.jpegQuality,
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
    glob: input.glob,
    action: input.action,
    mimeTypes: input.mimeTypes,
    priority: loose.priority ?? null,
    mediaType: loose.mediaType ?? null,
    imageWidth: loose.imageWidth ?? null,
    imageHeight: loose.imageHeight ?? null,
    tileRowCount: loose.tileRowCount ?? null,
    tileColumnCount: loose.tileColumnCount ?? null,
    tileSize: loose.tileSize ?? null,
    jpegQuality: loose.jpegQuality ?? null,
  };
}

/**
 * state.db's `thumbnail_policies` table -- global, versioned, shared across
 * every machine. Unlike `storage_policies`, there is no mandatory default
 * row: a path matching no policy glob at all is simply not a thumbnail
 * candidate.
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

  /** Every 'generate' row, ordered by priority (lower first) -- what thumbnail-policy resolution walks after checking for a 'skip' match. */
  listGenerateByPriority(): ThumbnailPolicyRow[] {
    return this.db
      .prepare<[], RawRow>(
        `SELECT ${ROW_COLUMNS} FROM thumbnail_policies WHERE action = 'generate' ORDER BY priority ASC, id ASC`,
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
    validateActionConsistency(flat);
    validateMimeTypes(flat.mimeTypes);
    if (flat.mediaType) validateMediaTypeMimeConsistency(flat.mediaType, flat.mimeTypes);

    const result = this.db
      .prepare<
        [
          string,
          ThumbnailPolicyAction,
          number | null,
          string,
          ThumbnailPolicyMediaType | null,
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
          glob, action, priority, mime_types, media_type, image_width, image_height,
          tile_row_count, tile_column_count, tile_size, jpeg_quality, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        flat.glob,
        flat.action,
        flat.priority,
        JSON.stringify(flat.mimeTypes),
        flat.mediaType,
        flat.imageWidth,
        flat.imageHeight,
        flat.tileRowCount,
        flat.tileColumnCount,
        flat.tileSize,
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
   * Switching to a different branch -- 'skip'->'generate',
   * 'generate'->'skip', or (staying 'generate' but) 'image'<->'video' --
   * drops every field of the branch being left: each must come fresh from
   * `changes`, exactly like the already-tested skip<->generate behavior.
   * The one exception is `jpegQuality`, the single field both 'generate'
   * branches share: it survives an 'image'<->'video' switch, since that
   * switch never actually leaves the 'generate' action at all. Branch-
   * switching a policy this way also requires resupplying `--mime-types`
   * to match the new media type, or `validateMediaTypeMimeConsistency`
   * rejects it below.
   */
  update(id: number, changes: ThumbnailPolicyUpdate): boolean {
    const row = this.get(id);
    if (!row) return false;
    const old = toFlatFields(row);

    const action = changes.action ?? old.action;
    const glob = changes.glob ?? old.glob;
    const mimeTypes = changes.mimeTypes ?? old.mimeTypes;
    const mediaType =
      action === "generate"
        ? (changes.mediaType ?? (old.action === "generate" ? old.mediaType : null))
        : null;

    const actionSwitched = action !== old.action;
    const branchChanged = actionSwitched || (action === "generate" && mediaType !== old.mediaType);

    const typeField = (name: TypeSpecificFieldName): number | null => {
      if (changes[name] !== undefined) return changes[name];
      return branchChanged ? null : old[name];
    };

    // jpegQuality drops only when the *action* itself switches (skip<->
    // generate); an image<->video switch leaves it alone, per the doc
    // comment above.
    const jpegQuality =
      changes.jpegQuality !== undefined
        ? changes.jpegQuality
        : actionSwitched
          ? null
          : old.jpegQuality;

    const priority =
      action === "skip" ? null : changes.priority !== undefined ? changes.priority : old.priority;

    const flat: FlatPolicyFields = {
      glob,
      action,
      priority,
      mimeTypes,
      mediaType,
      imageWidth: typeField("imageWidth"),
      imageHeight: typeField("imageHeight"),
      tileRowCount: typeField("tileRowCount"),
      tileColumnCount: typeField("tileColumnCount"),
      tileSize: typeField("tileSize"),
      jpegQuality,
    };

    validateActionConsistency(flat);
    validateMimeTypes(flat.mimeTypes);
    if (flat.mediaType) validateMediaTypeMimeConsistency(flat.mediaType, flat.mimeTypes);

    const result = this.db
      .prepare<
        [
          string,
          ThumbnailPolicyAction,
          number | null,
          string,
          ThumbnailPolicyMediaType | null,
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
          glob = ?, action = ?, priority = ?, mime_types = ?, media_type = ?, image_width = ?, image_height = ?,
          tile_row_count = ?, tile_column_count = ?, tile_size = ?, jpeg_quality = ?
        WHERE id = ?`,
      )
      .run(
        flat.glob,
        flat.action,
        flat.priority,
        JSON.stringify(flat.mimeTypes),
        flat.mediaType,
        flat.imageWidth,
        flat.imageHeight,
        flat.tileRowCount,
        flat.tileColumnCount,
        flat.tileSize,
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
