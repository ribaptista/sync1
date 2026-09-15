import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Command, OptionValues } from "commander";
import { createLogger, type Logger } from "../logger.js";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { getPassword } from "../cli/password.js";
import { createS3Client } from "../s3/client.js";
import { parseManifest, unlockVault } from "../vault/manifest.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import {
  sync1Dir,
  localStateDbPath,
  localVaultJsonPath,
  localRemoteConfigPath,
} from "../vault/local-dir.js";
import { normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import {
  ThumbnailPoliciesRepository,
  type ThumbnailPolicyRow,
  type ThumbnailPolicyAction,
  type ThumbnailPolicyCreateInput,
  type ThumbnailPolicyUpdate,
} from "../db/repositories/thumbnail-policies-repository.js";
import { mutateStateDb } from "../sync/mutate-state-db.js";

interface RootOption extends OptionValues {
  root: string;
}

interface GenerateFieldOptions {
  imageWidth?: string;
  imageHeight?: string;
  tileRows?: string;
  tileColumns?: string;
  tileWidth?: string;
  tileHeight?: string;
  jpegQuality?: string;
}

interface CreateOptions extends RootOption, GenerateFieldOptions {
  mimeTypes: string;
  priority?: string;
}

interface EditOptions extends RootOption, GenerateFieldOptions {
  glob?: string;
  action?: string;
  mimeTypes?: string;
  priority?: string;
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

function assertAttached(root: string): void {
  const sync1DirPath = sync1Dir(root);
  if (!fs.existsSync(sync1DirPath)) {
    throw new Error(`"${sync1DirPath}" does not exist — run init_remote or attach_remote first`);
  }
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

function parsePriority(raw: string): number {
  const priority = Number(raw);
  if (!Number.isInteger(priority)) {
    throw new Error(`invalid priority "${raw}" — expected an integer`);
  }
  return priority;
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

const GENERATE_FLAG_NAMES: Array<[flag: string, key: keyof GenerateFieldOptions]> = [
  ["--image-width", "imageWidth"],
  ["--image-height", "imageHeight"],
  ["--tile-rows", "tileRows"],
  ["--tile-columns", "tileColumns"],
  ["--tile-width", "tileWidth"],
  ["--tile-height", "tileHeight"],
  ["--jpeg-quality", "jpegQuality"],
];

interface ParsedGenerateFields {
  imageWidth?: number;
  imageHeight?: number;
  tileRowCount?: number;
  tileColumnCount?: number;
  tileWidth?: number;
  tileHeight?: number;
  jpegQuality?: number;
}

/** Parses whichever of the six generate-only flags were actually provided (each independently optional -- callers decide what "all" or "none" means for their command). */
function parseGenerateFields(opts: GenerateFieldOptions): ParsedGenerateFields {
  const fields: ParsedGenerateFields = {};
  if (opts.imageWidth !== undefined)
    fields.imageWidth = parsePositiveInt(opts.imageWidth, "--image-width");
  if (opts.imageHeight !== undefined)
    fields.imageHeight = parsePositiveInt(opts.imageHeight, "--image-height");
  if (opts.tileRows !== undefined)
    fields.tileRowCount = parsePositiveInt(opts.tileRows, "--tile-rows");
  if (opts.tileColumns !== undefined)
    fields.tileColumnCount = parsePositiveInt(opts.tileColumns, "--tile-columns");
  if (opts.tileWidth !== undefined)
    fields.tileWidth = parsePositiveInt(opts.tileWidth, "--tile-width");
  if (opts.tileHeight !== undefined)
    fields.tileHeight = parsePositiveInt(opts.tileHeight, "--tile-height");
  if (opts.jpegQuality !== undefined) fields.jpegQuality = parseJpegQuality(opts.jpegQuality);
  return fields;
}

/**
 * Fast, friendly, pre-network-round-trip check for `create`: a "skip"
 * policy must supply none of --priority or the six generate flags; a
 * "generate" policy must supply all six (--priority is still optional --
 * omitted, it's auto-assigned like storage_policy's own `nextPriority`).
 * The repository re-validates the same invariant regardless (its own CHECK
 * constraint enforces it at the SQL level too) -- this only exists to fail
 * before `setupMutationContext`'s password/KDF/network work for an
 * obviously-wrong combination of flags.
 */
function assertGenerateFlagsConsistentForCreate(
  action: ThumbnailPolicyAction,
  opts: CreateOptions,
): void {
  const present = GENERATE_FLAG_NAMES.filter(([, key]) => opts[key] !== undefined).map(
    ([flag]) => flag,
  );
  if (action === "skip") {
    const allPresent = opts.priority !== undefined ? ["--priority", ...present] : present;
    if (allPresent.length > 0) {
      throw new Error(`a "skip" policy can't set ${allPresent.join(", ")}`);
    }
    return;
  }
  const missing = GENERATE_FLAG_NAMES.filter(([, key]) => opts[key] === undefined).map(
    ([flag]) => flag,
  );
  if (missing.length > 0) {
    throw new Error(`a "generate" policy needs ${missing.join(", ")}`);
  }
}

async function setupMutationContext(opts: RootOption): Promise<MutationContext> {
  const root = path.resolve(opts.root);
  assertAttached(root);
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
  const root = path.resolve(opts.root);
  assertAttached(root);
  const stateDb = new Database(localStateDbPath(root), { readonly: true, fileMustExist: true });
  try {
    return new ThumbnailPoliciesRepository(stateDb).list();
  } finally {
    stateDb.close();
  }
}

/** Appends after every existing 'generate' policy (lowest precedence), computed fresh inside the mutation callback -- see storage_policy.ts's identical `nextPriority`. */
function nextPriority(repo: ThumbnailPoliciesRepository): number {
  const existing = repo.listGenerateByPriority();
  if (existing.length === 0) return 0;
  return Math.max(...existing.map((r) => r.priority ?? 0)) + 1;
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
    const input: ThumbnailPolicyCreateInput = { glob, action, mimeTypes, ...generateFields };
    if (action === "generate") {
      input.priority =
        opts.priority !== undefined ? parsePriority(opts.priority) : nextPriority(repo);
    }
    return repo.create(input);
  });
  return { id, action, versionStamp };
}

async function runEdit(
  id: number,
  opts: EditOptions,
  logger: Logger,
): Promise<{ versionStamp: string }> {
  const { root, masterKey, s3 } = await setupMutationContext(opts);
  const { versionStamp } = await mutateStateDb(root, masterKey, s3, logger, (db) => {
    const changes: ThumbnailPolicyUpdate = {};
    if (opts.glob !== undefined) changes.glob = opts.glob;
    if (opts.action !== undefined) changes.action = parseAction(opts.action);
    if (opts.mimeTypes !== undefined) changes.mimeTypes = parseMimeTypes(opts.mimeTypes);
    if (opts.priority !== undefined) changes.priority = parsePriority(opts.priority);
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
    .requiredOption("--root <path>", "local directory whose vault to inspect")
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
              `${r.id}\t${r.glob}\t${r.action}\tpriority=${r.priority ?? "-"}\tmime=${r.mimeTypes.join(",")}\n`,
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
    .requiredOption("--root <path>", "local directory whose vault to modify")
    .requiredOption("--mime-types <csv>", 'comma-separated mime types, e.g. "image/jpeg,video/*"')
    .option(
      "--priority <n>",
      "generate policies only; lower is checked first (default: appended last)",
    )
    .option("--image-width <n>", "generate policies only, for images")
    .option("--image-height <n>", "generate policies only, for images")
    .option("--tile-rows <n>", "generate policies only, for video mosaics")
    .option("--tile-columns <n>", "generate policies only, for video mosaics")
    .option("--tile-width <n>", "generate policies only, for video mosaics")
    .option("--tile-height <n>", "generate policies only, for video mosaics")
    .option("--jpeg-quality <1-100>", "generate policies only")
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
            glob,
            action: resolvedAction,
            version_stamp: versionStamp,
          });
        } else {
          process.stdout.write(
            `thumbnail policy ${id} created (version ${versionStamp}): ${glob} -> ${resolvedAction}\n`,
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
    .requiredOption("--root <path>", "local directory whose vault to modify")
    .option("--glob <glob>", "new glob pattern")
    .option("--action <action>", "new action: skip or generate")
    .option("--mime-types <csv>", "new comma-separated mime types")
    .option("--priority <n>", "new priority (generate policies only)")
    .option("--image-width <n>", "new image width (generate policies only)")
    .option("--image-height <n>", "new image height (generate policies only)")
    .option("--tile-rows <n>", "new tile row count (generate policies only)")
    .option("--tile-columns <n>", "new tile column count (generate policies only)")
    .option("--tile-width <n>", "new tile width (generate policies only)")
    .option("--tile-height <n>", "new tile height (generate policies only)")
    .option("--jpeg-quality <1-100>", "new jpeg quality (generate policies only)")
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
    .requiredOption("--root <path>", "local directory whose vault to modify")
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
