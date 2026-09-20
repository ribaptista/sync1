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
  GENERATE_BRANCH_FIELDS,
  type ThumbnailPolicyRow,
  type ThumbnailPolicyAction,
  type ThumbnailPolicyMediaType,
  type ThumbnailResizingStrategy,
  type ThumbnailOutputType,
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
  imageWidth?: string;
  imageHeight?: string;
  shorterSide?: string;
  tileRows?: string;
  tileColumns?: string;
  tileSize?: string;
  frameCount?: string;
  frameDelayMs?: string;
  jpegQuality?: string;
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
  if (raw !== "mosaic" && raw !== "gif") {
    throw new Error(`invalid output type "${raw}" — expected "mosaic" or "gif"`);
  }
  return raw;
}

function parsePositiveInt(raw: string, flagName: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid ${flagName} "${raw}" — expected a positive integer`);
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
  tileSize?: number;
  frameCount?: number;
  frameDelayMs?: number;
  jpegQuality?: number;
}

/**
 * The CLI's own flag name and raw-option-key for every field the
 * repository's `GENERATE_BRANCH_FIELDS` knows about -- the two field
 * names that differ from their repository name (`tileRows`/`tileColumns`
 * vs `tileRowCount`/`tileColumnCount`) are historical, kept for CLI
 * flag-naming ergonomics (`--tile-rows`, not `--tile-row-count`); every
 * other field's CLI option key already matches its repository name
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
  tileSize: { flag: "--tile-size", optionKey: "tileSize" },
  frameCount: { flag: "--frame-count", optionKey: "frameCount" },
  frameDelayMs: { flag: "--frame-delay-ms", optionKey: "frameDelayMs" },
  jpegQuality: { flag: "--jpeg-quality", optionKey: "jpegQuality" },
};

const ALL_GENERATE_FIELD_NAMES = Object.keys(FIELD_INFO) as GenerateFieldName[];

/** Fields that, by themselves, name exactly one branch -- used for the edit-only "don't mix branches" pre-check below. Deliberately excludes `tileSize`/`jpegQuality`, which are shared across more than one branch and so don't uniquely indicate one. */
const BRANCH_ONLY_FIELDS: Record<GenerateBranchKey, GenerateFieldName[]> = {
  "image:fit_to_box": ["imageWidth", "imageHeight"],
  "image:resize_shorter_side": ["shorterSide"],
  "video:mosaic": ["tileRowCount", "tileColumnCount"],
  "video:gif": ["frameCount", "frameDelayMs"],
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
  if (opts.tileSize !== undefined) fields.tileSize = parsePositiveInt(opts.tileSize, "--tile-size");
  if (opts.frameCount !== undefined)
    fields.frameCount = parsePositiveInt(opts.frameCount, "--frame-count");
  if (opts.frameDelayMs !== undefined)
    fields.frameDelayMs = parsePositiveInt(opts.frameDelayMs, "--frame-delay-ms");
  if (opts.jpegQuality !== undefined) fields.jpegQuality = parseJpegQuality(opts.jpegQuality);
  return fields;
}

/**
 * Fast, friendly, pre-network-round-trip check for `create`: a "skip"
 * policy must supply none of --media-type/--resizing-strategy/--output-
 * type or any generate flag; a "generate" policy must supply
 * --media-type, then (for "image") --resizing-strategy or (for "video")
 * --output-type, then exactly that branch's own fields
 * (`GENERATE_BRANCH_FIELDS`) and none of the other branches'. The
 * repository re-validates the same invariant regardless (its own CHECK
 * constraint enforces it at the SQL level too) -- this only exists to
 * fail before `setupMutationContext`'s password/KDF/network work for an
 * obviously-wrong combination of flags.
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

  let branchKey: GenerateBranchKey;
  if (mediaType === "image") {
    if (opts.outputType !== undefined) {
      throw new Error('a "generate" "image" policy can\'t set --output-type');
    }
    if (opts.resizingStrategy === undefined) {
      throw new Error('a "generate" "image" policy needs --resizing-strategy');
    }
    branchKey = `image:${parseResizingStrategy(opts.resizingStrategy)}`;
  } else {
    if (opts.resizingStrategy !== undefined) {
      throw new Error('a "generate" "video" policy can\'t set --resizing-strategy');
    }
    if (opts.outputType === undefined) {
      throw new Error('a "generate" "video" policy needs --output-type');
    }
    branchKey = `video:${parseOutputType(opts.outputType)}`;
  }
  const branchLabel = branchKey.replace(":", "/");

  const ownFieldNames = GENERATE_BRANCH_FIELDS[branchKey];
  const missing = ownFieldNames
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
 * one branch's own exclusive fields at once (e.g. both --image-width and
 * --frame-count), and can't set both --resizing-strategy and
 * --output-type (one is image-only, the other video-only). Full branch-
 * aware validation -- what's *required* depends on the *existing* row,
 * which isn't available here without a network round trip -- stays in
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

/** One-line summary of a row's media type, branch, and generation parameters -- "-" for a 'skip' row, which has none. Used by `list`'s plain-text (non-`--json`) output only; `--json` already returns every field structured. */
function generateSummary(row: ThumbnailPolicyRow): string {
  if (row.action === "skip") return "-";
  if (row.mediaType === "image") {
    return row.resizingStrategy === "fit_to_box"
      ? `image/fit_to_box(${row.imageWidth}x${row.imageHeight},q${row.jpegQuality})`
      : `image/resize_shorter_side(${row.shorterSide},q${row.jpegQuality})`;
  }
  return row.outputType === "mosaic"
    ? `video/mosaic(${row.tileRowCount}x${row.tileColumnCount},ts${row.tileSize},q${row.jpegQuality})`
    : `video/gif(ts${row.tileSize},frames${row.frameCount},delay${row.frameDelayMs}ms)`;
}

/**
 * Builds the real `ThumbnailPolicyCreateInput` union value from
 * independently-parsed pieces. The `!` assertions on `generateFields`'
 * own-type members are safe: `assertGenerateFlagsConsistentForCreate`
 * already ran (and would have thrown) before this is ever called, so
 * every field this branch needs is guaranteed present.
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
        jpegQuality: generateFields.jpegQuality!,
      };
    }
    return {
      name,
      glob,
      action: "generate",
      mediaType: "image",
      resizingStrategy: "resize_shorter_side",
      mimeTypes,
      shorterSide: generateFields.shorterSide!,
      jpegQuality: generateFields.jpegQuality!,
    };
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
      tileRowCount: generateFields.tileRowCount!,
      tileColumnCount: generateFields.tileColumnCount!,
      tileSize: generateFields.tileSize!,
      jpegQuality: generateFields.jpegQuality!,
    };
  }
  return {
    name,
    glob,
    action: "generate",
    mediaType: "video",
    outputType: "gif",
    mimeTypes,
    tileSize: generateFields.tileSize!,
    frameCount: generateFields.frameCount!,
    frameDelayMs: generateFields.frameDelayMs!,
  };
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
      "generate policies only, for 'resize_shorter_side' image policies -- the resized image's shorter side, in pixels",
    )
    .option(
      "--output-type <mosaic|gif>",
      "generate/video policies only; which of the tile-row/column or frame-count/delay fields applies",
    )
    .option("--tile-rows <n>", "generate policies only, for 'mosaic' video policies")
    .option("--tile-columns <n>", "generate policies only, for 'mosaic' video policies")
    .option(
      "--tile-size <n>",
      "generate policies only, for video policies -- one mosaic tile's or gif frame's shorter side, in pixels",
    )
    .option("--frame-count <n>", "generate policies only, for 'gif' video policies")
    .option(
      "--frame-delay-ms <n>",
      "generate policies only, for 'gif' video policies -- each frame's display duration",
    )
    .option("--jpeg-quality <1-100>", "generate policies only, every branch except 'gif'")
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
    .option(
      "--shorter-side <n>",
      "new shorter side, in pixels ('resize_shorter_side' image policies only)",
    )
    .option("--output-type <mosaic|gif>", "new output type (generate/video policies only)")
    .option("--tile-rows <n>", "new tile row count ('mosaic' video policies only)")
    .option("--tile-columns <n>", "new tile column count ('mosaic' video policies only)")
    .option(
      "--tile-size <n>",
      "new mosaic tile's or gif frame's shorter side, in pixels (generate/video policies only)",
    )
    .option("--frame-count <n>", "new frame count ('gif' video policies only)")
    .option("--frame-delay-ms <n>", "new per-frame display duration ('gif' video policies only)")
    .option(
      "--jpeg-quality <1-100>",
      "new jpeg quality (generate policies only, every branch except 'gif')",
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
