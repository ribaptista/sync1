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
  IgnorePoliciesRepository,
  type IgnorePolicyRow,
} from "../db/repositories/ignore-policies-repository.js";
import { mutateStateDb } from "../sync/mutate-state-db.js";

interface RootOption extends OptionValues {
  root: string;
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

async function runList(opts: RootOption): Promise<IgnorePolicyRow[]> {
  const root = path.resolve(opts.root);
  assertAttached(root);
  const stateDb = new Database(localStateDbPath(root), { readonly: true, fileMustExist: true });
  try {
    return new IgnorePoliciesRepository(stateDb).list();
  } finally {
    stateDb.close();
  }
}

async function runCreate(
  glob: string,
  opts: RootOption,
  logger: Logger,
): Promise<{ id: number; versionStamp: string }> {
  const { root, masterKey, s3 } = await setupMutationContext(opts);
  const { versionStamp, result: id } = await mutateStateDb(root, masterKey, s3, logger, (db) =>
    new IgnorePoliciesRepository(db).create(glob),
  );
  return { id, versionStamp };
}

async function runEdit(
  id: number,
  glob: string,
  opts: RootOption,
  logger: Logger,
): Promise<{ versionStamp: string }> {
  const { root, masterKey, s3 } = await setupMutationContext(opts);
  const { versionStamp } = await mutateStateDb(root, masterKey, s3, logger, (db) => {
    if (!new IgnorePoliciesRepository(db).update(id, glob)) {
      throw new Error(`no ignore policy with id ${id}`);
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
    if (!new IgnorePoliciesRepository(db).delete(id)) {
      throw new Error(`no ignore policy with id ${id}`);
    }
  });
  return { versionStamp };
}

export function registerIgnoreCommand(program: Command): void {
  const ignore = program
    .command("ignore")
    .description("Manage global ignore policies (GLOB patterns kept out of the vault entirely)");

  ignore
    .command("list")
    .description("List all ignore policies")
    .requiredOption("--root <path>", "local directory whose vault to inspect")
    .action(async (opts: RootOption, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "ignore_list" });
      try {
        const rows = await runList(opts);
        if (json) {
          emitJson({ ok: true, policies: rows });
        } else if (rows.length === 0) {
          process.stdout.write("no ignore policies\n");
        } else {
          for (const r of rows) process.stdout.write(`${r.id}\t${r.glob}\t${r.created_at}\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "ignore list failed");
        emitError(json, message, exitCodeForError(err));
      }
    });

  ignore
    .command("create")
    .description("Create a new ignore policy")
    .argument("<glob>", "SQLite GLOB pattern to ignore")
    .requiredOption("--root <path>", "local directory whose vault to modify")
    .action(async (glob: string, opts: RootOption, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "ignore_create" });
      try {
        const { id, versionStamp } = await runCreate(glob, opts, logger);
        if (json) {
          emitJson({ ok: true, id, glob, version_stamp: versionStamp });
        } else {
          process.stdout.write(`ignore policy ${id} created (version ${versionStamp}): ${glob}\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "ignore create failed");
        emitError(json, message, exitCodeForError(err));
      }
    });

  ignore
    .command("edit")
    .description("Edit an existing ignore policy's glob")
    .argument("<id>", "policy id")
    .argument("<glob>", "new SQLite GLOB pattern")
    .requiredOption("--root <path>", "local directory whose vault to modify")
    .action(async (idRaw: string, glob: string, opts: RootOption, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "ignore_edit" });
      try {
        const id = parseId(idRaw);
        const { versionStamp } = await runEdit(id, glob, opts, logger);
        if (json) {
          emitJson({ ok: true, id, glob, version_stamp: versionStamp });
        } else {
          process.stdout.write(`ignore policy ${id} updated (version ${versionStamp}): ${glob}\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "ignore edit failed");
        emitError(json, message, exitCodeForError(err));
      }
    });

  ignore
    .command("delete")
    .description("Delete an ignore policy")
    .argument("<id>", "policy id")
    .requiredOption("--root <path>", "local directory whose vault to modify")
    .action(async (idRaw: string, opts: RootOption, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "ignore_delete" });
      try {
        const id = parseId(idRaw);
        const { versionStamp } = await runDelete(id, opts, logger);
        if (json) {
          emitJson({ ok: true, id, version_stamp: versionStamp });
        } else {
          process.stdout.write(`ignore policy ${id} deleted (version ${versionStamp})\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "ignore delete failed");
        emitError(json, message, exitCodeForError(err));
      }
    });
}
