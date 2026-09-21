import fs from "node:fs";
import type { Command, OptionValues } from "commander";
import { createLogger, type Logger } from "../logger.js";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { getPassword } from "../cli/password.js";
import { createS3Client } from "../s3/client.js";
import { parseManifest, unlockVault } from "../vault/manifest.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import { localStateDbPath, localVaultJsonPath, localRemoteConfigPath } from "../vault/local-dir.js";
import { normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import {
  ThumbnailPoliciesRepository,
  SIZING_FIELDS,
  ENCODING_FIELDS,
  type ThumbnailPolicyRow,
  type ThumbnailPolicyAction,
  type ThumbnailPolicyMediaType,
  type ThumbnailResizingStrategy,
  type ThumbnailOutputType,
  type ThumbnailOutputMime,
  type ThumbnailGifDither,
  type ThumbnailPolicyCreateInput,
  type ThumbnailPolicyUpdate,
  type GenerateFieldName,
  type GenerateBranchKey,
} from "../db/repositories/thumbnail-policies-repository.js";
import { mutateStateDb } from "../sync/mutate-state-db.js";
import { resolveRoot } from "../cli/resolve-root.js";
import { openStateDbReadOnly } from "../db/connection.js";

interface RootOption extends OptionValues {
  root?: string;
}

interface GenerateFieldOptions {
  mediaType?: string;
  resizingStrategy?: string;
  outputType?: string;
  outputMime?: string;
  imageWidth?: string;
  imageHeight?: string;
  shorterSide?: string;
  tileRows?: string;
  tileColumns?: string;
  frameCount?: string;
  frameDelayMs?: string;
  jpegQuality?: string;
  pngCompressionLevel?: string;
  webpQuality?: string;
  webpLossless?: string;
  gifMaxColors?: string;
  gifDither?: string;
}

interface CreateOptions extends RootOption, GenerateFieldOptions {
  name: string;
  mimeTypes: string;
}

interface EditOptions extends RootOption, GenerateFieldOptions {
  name?: string;
  glob?: string;
  action?: string;
  mimeTypes?: string;
}

interface GlobalOptions extends OptionValues {
  json?: boolean;
  verbose?: boolean;
}

interface MutationContext {
  root: string;
  masterKey: Buffer;
  s3: { client: ReturnType<typeof createS3Client>; bucket: string; location: RemoteLocation };
}

function parseId(idRaw: string): number {
  const id = Number(idRaw);
  if (!Number.isInteger(id)) {
    throw new Error(`invalid policy id "${idRaw}" — expected an integer`);
  }
  return id;
}

function parseAction(raw: string): ThumbnailPolicyAction {
  if (raw !== "skip" && raw !== "generate") {
    throw new Error(`invalid action "${raw}" — expected "skip" or "generate"`);
  }
  return raw;
}

function parseMediaType(raw: string): ThumbnailPolicyMediaType {
  if (raw !== "image" && raw !== "video") {
    throw new Error(`invalid media type "${raw}" — expected "image" or "video"`);
  }
  return raw;
}

function parseResizingStrategy(raw: string): ThumbnailResizingStrategy {
  if (raw !== "fit_to_box" && raw !== "resize_shorter_side") {
    throw new Error(
      `invalid resizing strategy "${raw}" — expected "fit_to_box" or "resize_shorter_side"`,
    );
  }
  return raw;
}

function parseOutputType(raw: string): ThumbnailOutputType {
  if (raw !== "mosaic" && raw !== "preview") {
    throw new Error(`invalid output type "${raw}" — expected "mosaic" or "preview"`);
  }
  return raw;
}

const OUTPUT_MIME_VALUES: readonly ThumbnailOutputMime[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

function parseOutputMime(raw: string): ThumbnailOutputMime {
  if (!(OUTPUT_MIME_VALUES as readonly string[]).includes(raw)) {
    throw new Error(
      `invalid --output-mime "${raw}" — expected one of ${OUTPUT_MIME_VALUES.join(", ")}`,
    );
  }
  return raw as ThumbnailOutputMime;
}

const GIF_DITHER_VALUES: readonly ThumbnailGifDither[] = [
  "none",
  "bayer",
  "heckbert",
  "floyd_steinberg",
  "sierra2",
  "sierra2_4a",
  "sierra3",
  "burkes",
  "atkinson",
];

function parseGifDither(raw: string): ThumbnailGifDither {
  if (!(GIF_DITHER_VALUES as readonly string[]).includes(raw)) {
    throw new Error(
      `invalid --gif-dither "${raw}" — expected one of ${GIF_DITHER_VALUES.join(", ")}`,
    );
  }
  return raw as ThumbnailGifDither;
}

function parsePositiveInt(raw: string, flagName: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid ${flagName} "${raw}" — expected a positive integer`);
  }
  return n;
}

/** GIF's stored delay is centiseconds, and most browsers clamp a stored 0-1cs delay to 100ms -- below 20ms the requested delay is not what plays back, so this is rejected outright rather than silently rounded. See docs/cli/thumbnail_policy.md. */
const MIN_FRAME_DELAY_MS = 20;

function parseFrameDelayMs(raw: string): number {
  const n = parsePositiveInt(raw, "--frame-delay-ms");
  if (n < MIN_FRAME_DELAY_MS) {
    throw new Error(
      `invalid --frame-delay-ms "${raw}" — must be at least ${MIN_FRAME_DELAY_MS} (lower values make GIF playback unreliable)`,
    );
  }
  return n;
}

function parseJpegQuality(raw: string): number {
  const q = Number(raw);
  if (!Number.isInteger(q) || q < 1 || q > 100) {
    throw new Error(`invalid --jpeg-quality "${raw}" — expected an integer 1-100`);
  }
  return q;
}

function parsePngCompressionLevel(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 9) {
    throw new Error(`invalid --png-compression-level "${raw}" — expected an integer 0-9`);
  }
  return n;
}

function parseWebpQuality(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error(`invalid --webp-quality "${raw}" — expected an integer 1-100`);
  }
  return n;
}

function parseWebpLossless(raw: string): boolean {
  if (raw !== "true" && raw !== "false") {
    throw new Error(`invalid --webp-lossless "${raw}" — expected "true" or "false"`);
  }
  return raw === "true";
}

function parseGifMaxColors(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 2 || n > 256) {
    throw new Error(`invalid --gif-max-colors "${raw}" — expected an integer 2-256`);
  }
  return n;
}

function parseMimeTypes(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface ParsedGenerateFields {
  imageWidth?: number;
  imageHeight?: number;
  shorterSide?: number;
  tileRowCount?: number;
  tileColumnCount?: number;
  frameCount?: number;
  frameDelayMs?: number;
  jpegQuality?: number;
  pngCompressionLevel?: number;
  webpQuality?: number;
  webpLossless?: boolean;
  gifMaxColors?: number;
  gifDither?: ThumbnailGifDither;
}

/**
 * The CLI's own flag name and raw-option-key for every field the
 * repository's `SIZING_FIELDS`/`ENCODING_FIELDS` know about -- the two
 * field names that differ from their repository name (`tileRows`/
 * `tileColumns` vs `tileRowCount`/`tileColumnCount`) are historical, kept
 * for CLI flag-naming ergonomics (`--tile-rows`, not `--tile-row-count`);
 * every other field's CLI option key already matches its repository name
 * one-for-one.
 */
const FIELD_INFO: Record<
  GenerateFieldName,
  { flag: string; optionKey: keyof GenerateFieldOptions }
> = {
  imageWidth: { flag: "--image-width", optionKey: "imageWidth" },
  imageHeight: { flag: "--image-height", optionKey: "imageHeight" },
  shorterSide: { flag: "--shorter-side", optionKey: "shorterSide" },
  tileRowCount: { flag: "--tile-rows", optionKey: "tileRows" },
  tileColumnCount: { flag: "--tile-columns", optionKey: "tileColumns" },
  frameCount: { flag: "--frame-count", optionKey: "frameCount" },
  frameDelayMs: { flag: "--frame-delay-ms", optionKey: "frameDelayMs" },
  jpegQuality: { flag: "--jpeg-quality", optionKey: "jpegQuality" },
  pngCompressionLevel: { flag: "--png-compression-level", optionKey: "pngCompressionLevel" },
  webpQuality: { flag: "--webp-quality", optionKey: "webpQuality" },
  webpLossless: { flag: "--webp-lossless", optionKey: "webpLossless" },
  gifMaxColors: { flag: "--gif-max-colors", optionKey: "gifMaxColors" },
  gifDither: { flag: "--gif-dither", optionKey: "gifDither" },
};

const ALL_GENERATE_FIELD_NAMES = Object.keys(FIELD_INFO) as GenerateFieldName[];

/**
 * Encoding fields that have a CLI-layer default (see `ENCODING_DEFAULTS`
 * below) and so aren't required on `create` even though they're part of
 * their `output_mime`'s own field set. `jpegQuality` is deliberately the
 * only encoding field with no default -- it was already a required flag
 * before this policy gained a second discriminant, and there was no reason
 * to change that.
 */
const REQUIRED_ENCODING_FIELDS: Record<ThumbnailOutputMime, GenerateFieldName[]> = {
  "image/jpeg": ["jpegQuality"],
  "image/png": [],
  "image/webp": [],
  "image/gif": [],
};

/** Fields that, by themselves, name exactly one sizing branch -- used for the edit-only "don't mix branches" pre-check below. Deliberately excludes `shorterSide` (shared by every branch but `fit_to_box`) and every encoding field (shared across sizing branches entirely), neither of which uniquely indicates one branch. */
const BRANCH_ONLY_FIELDS: Record<GenerateBranchKey, GenerateFieldName[]> = {
  "image:fit_to_box": ["imageWidth", "imageHeight"],
  "image:resize_shorter_side": [],
  "video:mosaic": ["tileRowCount", "tileColumnCount"],
  "video:preview": ["frameCount", "frameDelayMs"],
};

function isPresent(opts: GenerateFieldOptions, name: GenerateFieldName): boolean {
  return opts[FIELD_INFO[name].optionKey] !== undefined;
}

/** Parses whichever of the generate-only flags were actually provided (each independently optional -- callers decide what "all" or "none" means for their command). */
function parseGenerateFields(opts: GenerateFieldOptions): ParsedGenerateFields {
  const fields: ParsedGenerateFields = {};
  if (opts.imageWidth !== undefined)
    fields.imageWidth = parsePositiveInt(opts.imageWidth, "--image-width");
  if (opts.imageHeight !== undefined)
    fields.imageHeight = parsePositiveInt(opts.imageHeight, "--image-height");
  if (opts.shorterSide !== undefined)
    fields.shorterSide = parsePositiveInt(opts.shorterSide, "--shorter-side");
  if (opts.tileRows !== undefined)
    fields.tileRowCount = parsePositiveInt(opts.tileRows, "--tile-rows");
  if (opts.tileColumns !== undefined)
    fields.tileColumnCount = parsePositiveInt(opts.tileColumns, "--tile-columns");
  if (opts.frameCount !== undefined)
    fields.frameCount = parsePositiveInt(opts.frameCount, "--frame-count");
  if (opts.frameDelayMs !== undefined) fields.frameDelayMs = parseFrameDelayMs(opts.frameDelayMs);
  if (opts.jpegQuality !== undefined) fields.jpegQuality = parseJpegQuality(opts.jpegQuality);
  if (opts.pngCompressionLevel !== undefined)
    fields.pngCompressionLevel = parsePngCompressionLevel(opts.pngCompressionLevel);
  if (opts.webpQuality !== undefined) fields.webpQuality = parseWebpQuality(opts.webpQuality);
  if (opts.webpLossless !== undefined) fields.webpLossless = parseWebpLossless(opts.webpLossless);
  if (opts.gifMaxColors !== undefined) fields.gifMaxColors = parseGifMaxColors(opts.gifMaxColors);
  if (opts.gifDither !== undefined) fields.gifDither = parseGifDither(opts.gifDither);
  return fields;
}

/**
 * Fast, friendly, pre-network-round-trip check for `create`: a "skip"
 * policy must supply none of --media-type/--resizing-strategy/--output-
 * type/--output-mime or any generate flag; a "generate" policy must supply
 * --media-type, then (for "image") --resizing-strategy or (for "video")
 * --output-type -- together the SIZING branch -- then --output-mime, then
 * that branch's own required fields (`SIZING_FIELDS` for sizing,
 * `REQUIRED_ENCODING_FIELDS` for encoding -- a defaultable encoding field
 * is optional here, see `ENCODING_DEFAULTS`) and none of the other
 * branches'/mimes' own fields. The repository re-validates the same
 * invariant regardless (its own CHECK constraint enforces it at the SQL
 * level too, including the sizing/encoding *legality* pairing this
 * pre-check doesn't attempt) -- this only exists to fail before
 * `setupMutationContext`'s password/KDF/network work for an obviously-wrong
 * combination of flags.
 */
function assertGenerateFlagsConsistentForCreate(
  action: ThumbnailPolicyAction,
  opts: CreateOptions,
): void {
  if (action === "skip") {
    const present = ALL_GENERATE_FIELD_NAMES.filter((name) => isPresent(opts, name)).map(
      (name) => FIELD_INFO[name].flag,
    );
    const allPresent = [
      ...(opts.mediaType !== undefined ? ["--media-type"] : []),
      ...(opts.resizingStrategy !== undefined ? ["--resizing-strategy"] : []),
      ...(opts.outputType !== undefined ? ["--output-type"] : []),
      ...(opts.outputMime !== undefined ? ["--output-mime"] : []),
      ...present,
    ];
    if (allPresent.length > 0) {
      throw new Error(`a "skip" policy can't set ${allPresent.join(", ")}`);
    }
    return;
  }

  if (opts.mediaType === undefined) {
    throw new Error('a "generate" policy needs --media-type');
  }
  const mediaType = parseMediaType(opts.mediaType);

  let sizingKey: GenerateBranchKey;
  if (mediaType === "image") {
    if (opts.outputType !== undefined) {
      throw new Error('a "generate" "image" policy can\'t set --output-type');
    }
    if (opts.resizingStrategy === undefined) {
      throw new Error('a "generate" "image" policy needs --resizing-strategy');
    }
    sizingKey = `image:${parseResizingStrategy(opts.resizingStrategy)}`;
  } else {
    if (opts.resizingStrategy !== undefined) {
      throw new Error('a "generate" "video" policy can\'t set --resizing-strategy');
    }
    if (opts.outputType === undefined) {
      throw new Error('a "generate" "video" policy needs --output-type');
    }
    sizingKey = `video:${parseOutputType(opts.outputType)}`;
  }
  const sizingLabel = sizingKey.replace(":", "/");

  if (opts.outputMime === undefined) {
    throw new Error(`a "generate" "${sizingLabel}" policy needs --output-mime`);
  }
  const outputMime = parseOutputMime(opts.outputMime);
  const branchLabel = `${sizingLabel}/${outputMime}`;

  const ownFieldNames = [...SIZING_FIELDS[sizingKey], ...ENCODING_FIELDS[outputMime]];
  const requiredFieldNames = [...SIZING_FIELDS[sizingKey], ...REQUIRED_ENCODING_FIELDS[outputMime]];

  const missing = requiredFieldNames
    .filter((name) => !isPresent(opts, name))
    .map((name) => FIELD_INFO[name].flag);
  if (missing.length > 0) {
    throw new Error(`a "generate" "${branchLabel}" policy needs ${missing.join(", ")}`);
  }

  const present = ALL_GENERATE_FIELD_NAMES.filter(
    (name) => !(ownFieldNames as readonly string[]).includes(name) && isPresent(opts, name),
  ).map((name) => FIELD_INFO[name].flag);
  if (present.length > 0) {
    throw new Error(`a "generate" "${branchLabel}" policy can't set ${present.join(", ")}`);
  }
}

/**
 * Cheap, edit-only pre-check: a single `edit` call can't name more than
 * one sizing branch's own exclusive fields at once (e.g. both
 * --image-width and --frame-count), and can't set both --resizing-strategy
 * and --output-type (one is image-only, the other video-only). Full
 * branch-aware validation -- what's *required* depends on the *existing*
 * row, which isn't available here without a network round trip -- stays in
 * the repository's own `update()`, same as today.
 */
function assertNoMixedBranchFlagsForEdit(opts: EditOptions): void {
  if (opts.resizingStrategy !== undefined && opts.outputType !== undefined) {
    throw new Error("can't set both --resizing-strategy and --output-type in the same edit");
  }

  const touchedBranches = (
    Object.entries(BRANCH_ONLY_FIELDS) as [GenerateBranchKey, GenerateFieldName[]][]
  )
    .map(([branchKey, names]) => ({
      branchKey,
      present: names.filter((name) => isPresent(opts, name)).map((name) => FIELD_INFO[name].flag),
    }))
    .filter((g) => g.present.length > 0);

  if (touchedBranches.length > 1) {
    const allFlags = touchedBranches.flatMap((g) => g.present);
    throw new Error(
      `can't set fields from more than one resizing strategy/output type at once: ${allFlags.join(", ")}`,
    );
  }
}

async function setupMutationContext(opts: RootOption): Promise<MutationContext> {
  const root = resolveRoot(opts.root);
  const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
  const password = await getPassword();
  const manifest = parseManifest(fs.readFileSync(localVaultJsonPath(root)));
  const masterKey = unlockVault(manifest, password);
  const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
  const prefix = normalizePrefix(remoteConfig.prefix);
  const location: RemoteLocation = { bucket: remoteConfig.bucket, prefix };
  return { root, masterKey, s3: { client, bucket: remoteConfig.bucket, location } };
}

async function runList(opts: RootOption): Promise<ThumbnailPolicyRow[]> {
  const root = resolveRoot(opts.root);
  const stateDb = openStateDbReadOnly(localStateDbPath(root));
  try {
    return new ThumbnailPoliciesRepository(stateDb).list();
  } finally {
    stateDb.close();
  }
}

/** One-line summary of a row's media type, sizing, and encoding parameters -- "-" for a 'skip' row, which has none. Used by `list`'s plain-text (non-`--json`) output only; `--json` already returns every field structured. */
function generateSummary(row: ThumbnailPolicyRow): string {
  if (row.action === "skip") return "-";

  const sizing =
    row.mediaType === "image"
      ? row.resizingStrategy === "fit_to_box"
        ? `image/fit_to_box(${row.imageWidth}x${row.imageHeight})`
        : `image/resize_shorter_side(ss${row.shorterSide})`
      : row.outputType === "mosaic"
        ? `video/mosaic(${row.tileRowCount}x${row.tileColumnCount},ss${row.shorterSide})`
        : `video/preview(ss${row.shorterSide},frames${row.frameCount},delay${row.frameDelayMs}ms)`;

  const encoding =
    row.outputMime === "image/jpeg"
      ? `jpeg(q${row.jpegQuality})`
      : row.outputMime === "image/png"
        ? `png(level${row.pngCompressionLevel})`
        : row.outputMime === "image/webp"
          ? `webp(q${row.webpQuality},lossless${row.webpLossless ? 1 : 0})`
          : `gif(colors${row.gifMaxColors},dither${row.gifDither})`;

  return `${sizing} ${encoding}`;
}

/**
 * CLI-layer defaults for encoding fields that don't have one -- applied
 * only at `create` time, so the stored row is always concrete and the
 * params segment (src/fs/thumbnail.ts) always reflects what was actually
 * used. `edit` never applies these: an encoding field left unset there
 * either carries over from the existing row (branch/mime unchanged) or is
 * required explicitly (branch/mime changed) -- see
 * `ThumbnailPoliciesRepository.update`'s own doc comment.
 */
const ENCODING_DEFAULTS = {
  pngCompressionLevel: 9,
  webpQuality: 80,
  webpLossless: false,
  gifMaxColors: 256,
  gifDither: "sierra2_4a" as ThumbnailGifDither,
};

/**
 * The ENCODING half of a `create` input, filling in `ENCODING_DEFAULTS`
 * for any field the CLI caller didn't pass. `jpegQuality` has no default
 * (`REQUIRED_ENCODING_FIELDS`) -- `assertGenerateFlagsConsistentForCreate`
 * already guarantees it's present by the time this runs.
 */
function buildEncodingInput(outputMime: ThumbnailOutputMime, generateFields: ParsedGenerateFields) {
  switch (outputMime) {
    case "image/jpeg":
      return { outputMime, jpegQuality: generateFields.jpegQuality! };
    case "image/png":
      return {
        outputMime,
        pngCompressionLevel:
          generateFields.pngCompressionLevel ?? ENCODING_DEFAULTS.pngCompressionLevel,
      };
    case "image/webp":
      return {
        outputMime,
        webpQuality: generateFields.webpQuality ?? ENCODING_DEFAULTS.webpQuality,
        webpLossless: generateFields.webpLossless ?? ENCODING_DEFAULTS.webpLossless,
      };
    case "image/gif":
      return {
        outputMime,
        gifMaxColors: generateFields.gifMaxColors ?? ENCODING_DEFAULTS.gifMaxColors,
        gifDither: generateFields.gifDither ?? ENCODING_DEFAULTS.gifDither,
      };
  }
}

/**
 * Builds the real `ThumbnailPolicyCreateInput` union value from
 * independently-parsed pieces. The `!` assertions on `generateFields`'
 * own-type members are safe: `assertGenerateFlagsConsistentForCreate`
 * already ran (and would have thrown) before this is ever called, so every
 * required field this branch needs is guaranteed present (defaultable
 * encoding fields are filled by `buildEncodingInput`). The `as
 * ThumbnailPolicyCreateInput` casts on the video branches mirror the
 * repository's own `fromRawRow` precedent: TS can't statically know
 * `LEGAL_OUTPUT_MIMES` already rules out e.g. gif-for-mosaic here -- the
 * repository's own validation is what actually guarantees it at runtime,
 * with a friendly error (see `assertGenerateFlagsConsistentForCreate` and
 * `ThumbnailPoliciesRepository.create`).
 */
function buildCreateInput(
  name: string,
  glob: string,
  action: ThumbnailPolicyAction,
  mimeTypes: string[],
  generateFields: ParsedGenerateFields,
  opts: CreateOptions,
): ThumbnailPolicyCreateInput {
  if (action === "skip") {
    return { name, glob, action: "skip", mimeTypes };
  }

  const mediaType = parseMediaType(opts.mediaType!);
  const outputMime = parseOutputMime(opts.outputMime!);
  const encoding = buildEncodingInput(outputMime, generateFields);

  if (mediaType === "image") {
    const resizingStrategy = parseResizingStrategy(opts.resizingStrategy!);
    if (resizingStrategy === "fit_to_box") {
      return {
        name,
        glob,
        action: "generate",
        mediaType: "image",
        resizingStrategy: "fit_to_box",
        mimeTypes,
        imageWidth: generateFields.imageWidth!,
        imageHeight: generateFields.imageHeight!,
        ...encoding,
      } as ThumbnailPolicyCreateInput;
    }
    return {
      name,
      glob,
      action: "generate",
      mediaType: "image",
      resizingStrategy: "resize_shorter_side",
      mimeTypes,
      shorterSide: generateFields.shorterSide!,
      ...encoding,
    } as ThumbnailPolicyCreateInput;
  }

  const outputType = parseOutputType(opts.outputType!);
  if (outputType === "mosaic") {
    return {
      name,
      glob,
      action: "generate",
      mediaType: "video",
      outputType: "mosaic",
      mimeTypes,
      shorterSide: generateFields.shorterSide!,
      tileRowCount: generateFields.tileRowCount!,
      tileColumnCount: generateFields.tileColumnCount!,
      ...encoding,
    } as ThumbnailPolicyCreateInput;
  }
  return {
    name,
    glob,
    action: "generate",
    mediaType: "video",
    outputType: "preview",
    mimeTypes,
    shorterSide: generateFields.shorterSide!,
    frameCount: generateFields.frameCount!,
    frameDelayMs: generateFields.frameDelayMs!,
    ...encoding,
  } as ThumbnailPolicyCreateInput;
}

async function runCreate(
  glob: string,
  actionRaw: string,
  opts: CreateOptions,
  logger: Logger,
): Promise<{ id: number; action: ThumbnailPolicyAction; versionStamp: string }> {
  const action = parseAction(actionRaw);
  assertGenerateFlagsConsistentForCreate(action, opts);
  const mimeTypes = parseMimeTypes(opts.mimeTypes);
  const generateFields = parseGenerateFields(opts);

  const { root, masterKey, s3 } = await setupMutationContext(opts);
  const { versionStamp, result: id } = await mutateStateDb(root, masterKey, s3, logger, (db) => {
    const repo = new ThumbnailPoliciesRepository(db);
    const input = buildCreateInput(opts.name, glob, action, mimeTypes, generateFields, opts);
    return repo.create(input);
  });
  return { id, action, versionStamp };
}

async function runEdit(
  id: number,
  opts: EditOptions,
  logger: Logger,
): Promise<{ versionStamp: string }> {
  assertNoMixedBranchFlagsForEdit(opts);
  const { root, masterKey, s3 } = await setupMutationContext(opts);
  const { versionStamp } = await mutateStateDb(root, masterKey, s3, logger, (db) => {
    const changes: ThumbnailPolicyUpdate = {};
    if (opts.name !== undefined) changes.name = opts.name;
    if (opts.glob !== undefined) changes.glob = opts.glob;
    if (opts.action !== undefined) changes.action = parseAction(opts.action);
    if (opts.mimeTypes !== undefined) changes.mimeTypes = parseMimeTypes(opts.mimeTypes);
    if (opts.mediaType !== undefined) changes.mediaType = parseMediaType(opts.mediaType);
    if (opts.resizingStrategy !== undefined)
      changes.resizingStrategy = parseResizingStrategy(opts.resizingStrategy);
    if (opts.outputType !== undefined) changes.outputType = parseOutputType(opts.outputType);
    if (opts.outputMime !== undefined) changes.outputMime = parseOutputMime(opts.outputMime);
    Object.assign(changes, parseGenerateFields(opts));
    if (!new ThumbnailPoliciesRepository(db).update(id, changes)) {
      throw new Error(`no thumbnail policy with id ${id}`);
    }
  });
  return { versionStamp };
}

async function runDelete(
  id: number,
  opts: RootOption,
  logger: Logger,
): Promise<{ versionStamp: string }> {
  const { root, masterKey, s3 } = await setupMutationContext(opts);
  const { versionStamp } = await mutateStateDb(root, masterKey, s3, logger, (db) => {
    if (!new ThumbnailPoliciesRepository(db).delete(id)) {
      throw new Error(`no thumbnail policy with id ${id}`);
    }
  });
  return { versionStamp };
}

export function registerThumbnailPolicyCommand(program: Command): void {
  const thumbnailPolicy = program
    .command("thumbnail_policy")
    .description(
      "Manage global thumbnail-generation policies (glob + mime-type patterns mapped to skip/generate)",
    );

  thumbnailPolicy
    .command("list")
    .description("List all thumbnail policies")
    .option(
      "--root <path>",
      "local directory whose vault to inspect (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .action(async (opts: RootOption, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({
        command: "thumbnail_policy_list",
      });
      try {
        const rows = await runList(opts);
        if (json) {
          emitJson({ ok: true, policies: rows });
        } else {
          for (const r of rows) {
            process.stdout.write(
              `${r.id}\t${r.name}\t${r.glob}\t${r.action}\t${generateSummary(r)}\tmime=${r.mimeTypes.join(",")}\n`,
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "thumbnail_policy list failed");
        emitError(json, message, exitCodeForError(err));
      }
    });

  thumbnailPolicy
    .command("create")
    .description("Create a new thumbnail policy")
    .argument("<glob>", "glob pattern")
    .argument("<action>", "skip or generate")
    .option(
      "--root <path>",
      "local directory whose vault to modify (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .requiredOption(
      "--name <name>",
      "unique identifier, letters/digits/underscore only -- appears in generated thumbnails' filenames",
    )
    .requiredOption("--mime-types <csv>", 'comma-separated mime types, e.g. "image/jpeg,video/*"')
    .option("--media-type <image|video>", "generate policies only; which field set applies")
    .option(
      "--resizing-strategy <fit_to_box|resize_shorter_side>",
      "generate/image policies only; which of --image-width/--image-height or --shorter-side applies",
    )
    .option("--image-width <n>", "generate policies only, for 'fit_to_box' image policies")
    .option("--image-height <n>", "generate policies only, for 'fit_to_box' image policies")
    .option(
      "--shorter-side <n>",
      "generate policies only, for every branch except 'fit_to_box' -- one output unit's shorter side, in pixels: the resized image's own for 'resize_shorter_side', one tile's for 'mosaic' (not the composed grid's), one frame's for 'preview'",
    )
    .option(
      "--output-type <mosaic|preview>",
      "generate/video policies only; which of the tile-row/column or frame-count/delay fields applies",
    )
    .option("--tile-rows <n>", "generate policies only, for 'mosaic' video policies")
    .option("--tile-columns <n>", "generate policies only, for 'mosaic' video policies")
    .option("--frame-count <n>", "generate policies only, for 'preview' video policies")
    .option(
      "--frame-delay-ms <n>",
      `generate policies only, for 'preview' video policies -- each frame's display duration, minimum ${MIN_FRAME_DELAY_MS}ms. GIF output stores this in centiseconds (10ms granularity, rounded); animated WebP stores it exactly.`,
    )
    .option(
      "--output-mime <image/jpeg|image/png|image/webp|image/gif>",
      "generate policies only, always required -- the produced thumbnail's format. 'mosaic' never allows image/gif (a one-frame \"animation\"); 'preview' only allows image/gif or image/webp (always animated)",
    )
    .option("--jpeg-quality <1-100>", "required when --output-mime is image/jpeg")
    .option(
      "--png-compression-level <0-9>",
      "when --output-mime is image/png -- lossless compression effort, not visual quality (default 9)",
    )
    .option("--webp-quality <1-100>", "when --output-mime is image/webp (default 80)")
    .option("--webp-lossless <true|false>", "when --output-mime is image/webp (default false)")
    .option("--gif-max-colors <2-256>", "when --output-mime is image/gif (default 256)")
    .option(
      `--gif-dither <${GIF_DITHER_VALUES.join("|")}>`,
      "when --output-mime is image/gif (default sierra2_4a)",
    )
    .action(async (glob: string, action: string, opts: CreateOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({
        command: "thumbnail_policy_create",
      });
      try {
        const {
          id,
          action: resolvedAction,
          versionStamp,
        } = await runCreate(glob, action, opts, logger);
        if (json) {
          emitJson({
            ok: true,
            id,
            name: opts.name,
            glob,
            action: resolvedAction,
            version_stamp: versionStamp,
          });
        } else {
          process.stdout.write(
            `thumbnail policy ${id} (${opts.name}) created (version ${versionStamp}): ${glob} -> ${resolvedAction}\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "thumbnail_policy create failed");
        emitError(json, message, exitCodeForError(err));
      }
    });

  thumbnailPolicy
    .command("edit")
    .description("Edit an existing thumbnail policy")
    .argument("<id>", "policy id")
    .option(
      "--root <path>",
      "local directory whose vault to modify (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .option("--name <name>", "new unique identifier, letters/digits/underscore only")
    .option("--glob <glob>", "new glob pattern")
    .option("--action <action>", "new action: skip or generate")
    .option("--mime-types <csv>", "new comma-separated mime types")
    .option("--media-type <image|video>", "new media type (generate policies only)")
    .option(
      "--resizing-strategy <fit_to_box|resize_shorter_side>",
      "new resizing strategy (generate/image policies only)",
    )
    .option("--image-width <n>", "new image width ('fit_to_box' image policies only)")
    .option("--image-height <n>", "new image height ('fit_to_box' image policies only)")
    .option("--shorter-side <n>", "new shorter side, in pixels (every branch except 'fit_to_box')")
    .option("--output-type <mosaic|preview>", "new output type (generate/video policies only)")
    .option("--tile-rows <n>", "new tile row count ('mosaic' video policies only)")
    .option("--tile-columns <n>", "new tile column count ('mosaic' video policies only)")
    .option("--frame-count <n>", "new frame count ('preview' video policies only)")
    .option(
      "--frame-delay-ms <n>",
      `new per-frame display duration ('preview' video policies only, minimum ${MIN_FRAME_DELAY_MS}ms)`,
    )
    .option(
      "--output-mime <image/jpeg|image/png|image/webp|image/gif>",
      "new output mime (generate policies only)",
    )
    .option("--jpeg-quality <1-100>", "new jpeg quality (when output mime is image/jpeg)")
    .option(
      "--png-compression-level <0-9>",
      "new png compression level (when output mime is image/png)",
    )
    .option("--webp-quality <1-100>", "new webp quality (when output mime is image/webp)")
    .option(
      "--webp-lossless <true|false>",
      "new webp lossless flag (when output mime is image/webp)",
    )
    .option("--gif-max-colors <2-256>", "new gif max colors (when output mime is image/gif)")
    .option(
      `--gif-dither <${GIF_DITHER_VALUES.join("|")}>`,
      "new gif dither mode (when output mime is image/gif)",
    )
    .action(async (idRaw: string, opts: EditOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({
        command: "thumbnail_policy_edit",
      });
      try {
        const id = parseId(idRaw);
        const { versionStamp } = await runEdit(id, opts, logger);
        if (json) {
          emitJson({ ok: true, id, version_stamp: versionStamp });
        } else {
          process.stdout.write(`thumbnail policy ${id} updated (version ${versionStamp})\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "thumbnail_policy edit failed");
        emitError(json, message, exitCodeForError(err));
      }
    });

  thumbnailPolicy
    .command("delete")
    .description("Delete a thumbnail policy")
    .argument("<id>", "policy id")
    .option(
      "--root <path>",
      "local directory whose vault to modify (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .action(async (idRaw: string, opts: RootOption, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({
        command: "thumbnail_policy_delete",
      });
      try {
        const id = parseId(idRaw);
        const { versionStamp } = await runDelete(id, opts, logger);
        if (json) {
          emitJson({ ok: true, id, version_stamp: versionStamp });
        } else {
          process.stdout.write(`thumbnail policy ${id} deleted (version ${versionStamp})\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "thumbnail_policy delete failed");
        emitError(json, message, exitCodeForError(err));
      }
    });
}
