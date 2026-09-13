import type Database from "better-sqlite3";

export type ThumbnailPolicyAction = "skip" | "generate";

const MIME_TYPE_PATTERN = /^[a-zA-Z0-9.+-]+\/(\*|[a-zA-Z0-9.+-]+)$/;

/** The six fields that describe how to generate a thumbnail -- NULL for a 'skip' row, all required for a 'generate' row. */
export interface ThumbnailPolicyGenerateSettings {
  imageWidth: number;
  imageHeight: number;
  tileRowCount: number;
  tileColumnCount: number;
  tileWidth: number;
  tileHeight: number;
  jpegQuality: number;
}

export interface ThumbnailPolicyRow {
  id: number;
  glob: string;
  action: ThumbnailPolicyAction;
  priority: number | null;
  mimeTypes: string[];
  imageWidth: number | null;
  imageHeight: number | null;
  tileRowCount: number | null;
  tileColumnCount: number | null;
  tileWidth: number | null;
  tileHeight: number | null;
  jpegQuality: number | null;
  createdAt: string;
}

interface GenerateFields {
  imageWidth?: number;
  imageHeight?: number;
  tileRowCount?: number;
  tileColumnCount?: number;
  tileWidth?: number;
  tileHeight?: number;
  jpegQuality?: number;
}

export interface ThumbnailPolicyCreateInput extends GenerateFields {
  glob: string;
  action: ThumbnailPolicyAction;
  mimeTypes: string[];
  priority?: number;
}

export interface ThumbnailPolicyUpdate extends GenerateFields {
  glob?: string;
  action?: ThumbnailPolicyAction;
  mimeTypes?: string[];
  priority?: number;
}

const GENERATE_FIELD_NAMES = [
  "imageWidth",
  "imageHeight",
  "tileRowCount",
  "tileColumnCount",
  "tileWidth",
  "tileHeight",
  "jpegQuality",
] as const;

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
 * Checks the action/priority/generate-fields consistency invariant the
 * `thumbnail_policies` table's CHECK constraint also enforces, but ahead of
 * time with a friendly, field-naming error message: a `skip` row must have
 * no `priority` and no generate fields at all; a `generate` row must have a
 * `priority` and every one of the six generate fields.
 */
function validateActionConsistency(
  action: ThumbnailPolicyAction,
  priority: number | null,
  generate: Partial<Record<(typeof GENERATE_FIELD_NAMES)[number], number | null>>,
): void {
  if (action === "skip") {
    if (priority !== null) {
      throw new Error("a 'skip' policy can't have a priority");
    }
    const present = GENERATE_FIELD_NAMES.filter((name) => generate[name] != null);
    if (present.length > 0) {
      throw new Error(`a 'skip' policy can't set ${present.join(", ")}`);
    }
    return;
  }

  if (priority === null) {
    throw new Error("a 'generate' policy needs a priority");
  }
  const missing = GENERATE_FIELD_NAMES.filter((name) => generate[name] == null);
  if (missing.length > 0) {
    throw new Error(`a 'generate' policy needs ${missing.join(", ")}`);
  }
}

const ROW_COLUMNS =
  "id, glob, action, priority, mime_types, image_width, image_height, " +
  "tile_row_count, tile_column_count, tile_width, tile_height, jpeg_quality, created_at";

interface RawRow {
  id: number;
  glob: string;
  action: ThumbnailPolicyAction;
  priority: number | null;
  mime_types: string;
  image_width: number | null;
  image_height: number | null;
  tile_row_count: number | null;
  tile_column_count: number | null;
  tile_width: number | null;
  tile_height: number | null;
  jpeg_quality: number | null;
  created_at: string;
}

function fromRawRow(row: RawRow): ThumbnailPolicyRow {
  return {
    id: row.id,
    glob: row.glob,
    action: row.action,
    priority: row.priority,
    mimeTypes: JSON.parse(row.mime_types) as string[],
    imageWidth: row.image_width,
    imageHeight: row.image_height,
    tileRowCount: row.tile_row_count,
    tileColumnCount: row.tile_column_count,
    tileWidth: row.tile_width,
    tileHeight: row.tile_height,
    jpegQuality: row.jpeg_quality,
    createdAt: row.created_at,
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
    const priority = input.priority ?? null;
    validateActionConsistency(input.action, priority, input);
    validateMimeTypes(input.mimeTypes);

    const result = this.db
      .prepare<
        [
          string,
          ThumbnailPolicyAction,
          number | null,
          string,
          number | null,
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
          glob, action, priority, mime_types, image_width, image_height,
          tile_row_count, tile_column_count, tile_width, tile_height, jpeg_quality, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.glob,
        input.action,
        priority,
        JSON.stringify(input.mimeTypes),
        input.imageWidth ?? null,
        input.imageHeight ?? null,
        input.tileRowCount ?? null,
        input.tileColumnCount ?? null,
        input.tileWidth ?? null,
        input.tileHeight ?? null,
        input.jpegQuality ?? null,
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  /** Applies a partial update, merging onto the existing row and re-validating the resulting whole. Returns `false` for a nonexistent id. */
  update(id: number, changes: ThumbnailPolicyUpdate): boolean {
    const row = this.get(id);
    if (!row) return false;

    const action = changes.action ?? row.action;
    const glob = changes.glob ?? row.glob;
    const mimeTypes = changes.mimeTypes ?? row.mimeTypes;
    const priority = changes.priority !== undefined ? changes.priority : row.priority;
    const generate: Record<(typeof GENERATE_FIELD_NAMES)[number], number | null> = {
      imageWidth: changes.imageWidth !== undefined ? changes.imageWidth : row.imageWidth,
      imageHeight: changes.imageHeight !== undefined ? changes.imageHeight : row.imageHeight,
      tileRowCount: changes.tileRowCount !== undefined ? changes.tileRowCount : row.tileRowCount,
      tileColumnCount:
        changes.tileColumnCount !== undefined ? changes.tileColumnCount : row.tileColumnCount,
      tileWidth: changes.tileWidth !== undefined ? changes.tileWidth : row.tileWidth,
      tileHeight: changes.tileHeight !== undefined ? changes.tileHeight : row.tileHeight,
      jpegQuality: changes.jpegQuality !== undefined ? changes.jpegQuality : row.jpegQuality,
    };
    // Switching action clears whichever side no longer applies, rather than
    // carrying over stale values from the row's previous action.
    const effectivePriority = action === "skip" ? null : priority;
    const effectiveGenerate: Record<(typeof GENERATE_FIELD_NAMES)[number], number | null> =
      action === "skip"
        ? {
            imageWidth: null,
            imageHeight: null,
            tileRowCount: null,
            tileColumnCount: null,
            tileWidth: null,
            tileHeight: null,
            jpegQuality: null,
          }
        : generate;

    validateActionConsistency(action, effectivePriority, effectiveGenerate);
    validateMimeTypes(mimeTypes);

    const result = this.db
      .prepare<
        [
          string,
          ThumbnailPolicyAction,
          number | null,
          string,
          number | null,
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
          glob = ?, action = ?, priority = ?, mime_types = ?, image_width = ?, image_height = ?,
          tile_row_count = ?, tile_column_count = ?, tile_width = ?, tile_height = ?, jpeg_quality = ?
        WHERE id = ?`,
      )
      .run(
        glob,
        action,
        effectivePriority,
        JSON.stringify(mimeTypes),
        effectiveGenerate.imageWidth,
        effectiveGenerate.imageHeight,
        effectiveGenerate.tileRowCount,
        effectiveGenerate.tileColumnCount,
        effectiveGenerate.tileWidth,
        effectiveGenerate.tileHeight,
        effectiveGenerate.jpegQuality,
        id,
      );
    return result.changes > 0;
  }

  delete(id: number): boolean {
    const result = this.db.prepare<[number]>("DELETE FROM thumbnail_policies WHERE id = ?").run(id);
    return result.changes > 0;
  }
}
