import fs from "node:fs";
import Database from "better-sqlite3";
import type { Command, OptionValues } from "commander";
import { createLogger, type Logger } from "../logger.js";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { getPassword } from "../cli/password.js";
import { createS3Client } from "../s3/client.js";
import { isSupportedStorageClass } from "../s3/archive-status.js";
import { parseManifest, unlockVault } from "../vault/manifest.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import { localStateDbPath, localVaultJsonPath, localRemoteConfigPath } from "../vault/local-dir.js";
import { normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import {
  StoragePoliciesRepository,
  type StoragePolicyRow,
  type StorageClass,
} from "../db/repositories/storage-policies-repository.js";
import { mutateStateDb } from "../sync/mutate-state-db.js";
import { resolveRoot } from "../cli/resolve-root.js";

interface RootOption extends OptionValues {
  root?: string;
}

interface CreateOptions extends RootOption {
  priority?: string;
}

interface EditOptions extends RootOption {
  glob?: string;
  class?: string;
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

function parseId(idRaw: string): number {
  const id = Number(idRaw);
  if (!Number.isInteger(id)) {
    throw new Error(`invalid policy id "${idRaw}" — expected an integer`);
  }
  return id;
}

function parseStorageClass(raw: string): StorageClass {
  if (!isSupportedStorageClass(raw)) {
    throw new Error(
      `unsupported storage class "${raw}" — expected STANDARD, GLACIER, or DEEP_ARCHIVE`,
    );
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

async function runList(opts: RootOption): Promise<StoragePolicyRow[]> {
  const root = resolveRoot(opts.root);
  const stateDb = new Database(localStateDbPath(root), { readonly: true, fileMustExist: true });
  try {
    return new StoragePoliciesRepository(stateDb).list();
  } finally {
    stateDb.close();
  }
}

/**
 * A caller-omitted --priority appends the new policy after every existing
 * non-default one (lowest precedence among non-defaults, still ahead of
 * the default) -- computed from the candidate db's own fresh read inside
 * the mutation callback, so a concurrent commit's own new policy is never
 * silently clobbered by a stale priority computed before this attempt's
 * own CAS retry.
 */
function nextPriority(repo: StoragePoliciesRepository): number {
  const existing = repo.listNonDefaultByPriority();
  if (existing.length === 0) return 0;
  return Math.max(...existing.map((r) => r.priority ?? 0)) + 1;
}

async function runCreate(
  glob: string,
  targetClass: StorageClass,
  priorityRaw: string | undefined,
  opts: RootOption,
  logger: Logger,
): Promise<{ id: number; versionStamp: string }> {
  const { root, masterKey, s3 } = await setupMutationContext(opts);
  const { versionStamp, result: id } = await mutateStateDb(root, masterKey, s3, logger, (db) => {
    const repo = new StoragePoliciesRepository(db);
    const priority = priorityRaw !== undefined ? parsePriority(priorityRaw) : nextPriority(repo);
    return repo.create(glob, targetClass, priority);
  });
  return { id, versionStamp };
}

async function runEdit(
  id: number,
  opts: EditOptions,
  logger: Logger,
): Promise<{ versionStamp: string }> {
  const { root, masterKey, s3 } = await setupMutationContext(opts);
  const { versionStamp } = await mutateStateDb(root, masterKey, s3, logger, (db) => {
    const changes: { glob?: string; targetClass?: StorageClass; priority?: number } = {};
    if (opts.glob !== undefined) changes.glob = opts.glob;
    if (opts.class !== undefined) changes.targetClass = parseStorageClass(opts.class);
    if (opts.priority !== undefined) changes.priority = parsePriority(opts.priority);
    if (!new StoragePoliciesRepository(db).update(id, changes)) {
      throw new Error(`no storage policy with id ${id}`);
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
    if (!new StoragePoliciesRepository(db).delete(id)) {
      throw new Error(`no storage policy with id ${id}`);
    }
  });
  return { versionStamp };
}

export function registerStoragePolicyCommand(program: Command): void {
  const storagePolicy = program
    .command("storage_policy")
    .description(
      "Manage global storage-class policies (glob patterns mapped to a target S3 storage class)",
    );

  storagePolicy
    .command("list")
    .description("List all storage-class policies (default last, non-default by priority)")
    .option(
      "--root <path>",
      "local directory whose vault to inspect (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .action(async (opts: RootOption, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({
        command: "storage_policy_list",
      });
      try {
        const rows = await runList(opts);
        if (json) {
          emitJson({ ok: true, policies: rows });
        } else {
          for (const r of rows) {
            const label = r.is_default ? "(default)" : (r.glob ?? "");
            process.stdout.write(
              `${r.id}\t${label}\t${r.target_class}\tpriority=${r.priority ?? "-"}\n`,
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "storage_policy list failed");
        emitError(json, message, exitCodeForError(err));
      }
    });

  storagePolicy
    .command("create")
    .description("Create a new storage-class policy")
    .argument("<glob>", "glob pattern matched against tracked paths")
    .argument("<class>", "target storage class: STANDARD, GLACIER, or DEEP_ARCHIVE")
    .option(
      "--root <path>",
      "local directory whose vault to modify (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .option(
      "--priority <n>",
      "lower is checked first among non-default policies (default: appended last)",
    )
    .action(async (glob: string, classRaw: string, opts: CreateOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({
        command: "storage_policy_create",
      });
      try {
        const targetClass = parseStorageClass(classRaw);
        const { id, versionStamp } = await runCreate(
          glob,
          targetClass,
          opts.priority,
          opts,
          logger,
        );
        if (json) {
          emitJson({ ok: true, id, glob, target_class: targetClass, version_stamp: versionStamp });
        } else {
          process.stdout.write(
            `storage policy ${id} created (version ${versionStamp}): ${glob} -> ${targetClass}\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "storage_policy create failed");
        emitError(json, message, exitCodeForError(err));
      }
    });

  storagePolicy
    .command("edit")
    .description("Edit an existing storage-class policy")
    .argument("<id>", "policy id")
    .option(
      "--root <path>",
      "local directory whose vault to modify (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .option("--glob <glob>", "new glob pattern (rejected for the default policy)")
    .option("--class <class>", "new target storage class")
    .option("--priority <n>", "new priority (rejected for the default policy)")
    .action(async (idRaw: string, opts: EditOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({
        command: "storage_policy_edit",
      });
      try {
        const id = parseId(idRaw);
        const { versionStamp } = await runEdit(id, opts, logger);
        if (json) {
          emitJson({ ok: true, id, version_stamp: versionStamp });
        } else {
          process.stdout.write(`storage policy ${id} updated (version ${versionStamp})\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "storage_policy edit failed");
        emitError(json, message, exitCodeForError(err));
      }
    });

  storagePolicy
    .command("delete")
    .description("Delete a storage-class policy (the default policy can never be deleted)")
    .argument("<id>", "policy id")
    .option(
      "--root <path>",
      "local directory whose vault to modify (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .action(async (idRaw: string, opts: RootOption, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({
        command: "storage_policy_delete",
      });
      try {
        const id = parseId(idRaw);
        const { versionStamp } = await runDelete(id, opts, logger);
        if (json) {
          emitJson({ ok: true, id, version_stamp: versionStamp });
        } else {
          process.stdout.write(`storage policy ${id} deleted (version ${versionStamp})\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "storage_policy delete failed");
        emitError(json, message, exitCodeForError(err));
      }
    });
}
