import fs from "node:fs";
import path from "node:path";
import type { Command, OptionValues } from "commander";
import { createLogger } from "../logger.js";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { getPassword } from "../cli/password.js";
import { createS3Client, getObject } from "../s3/client.js";
import { parseManifest, unlockVault } from "../vault/manifest.js";
import {
  sync1Dir,
  localStateDbPath,
  localCacheDbPath,
  localVaultJsonPath,
  localRemoteConfigPath,
  lastSyncedVersionPath,
} from "../vault/local-dir.js";
import { serializeRemoteConfig, type RemoteConfig } from "../vault/remote-config.js";
import {
  remoteKey,
  normalizePrefix,
  VAULT_MANIFEST_KEY,
  stateSnapshotKey,
  CURRENT_POINTER_KEY,
  type RemoteLocation,
} from "../vault/paths.js";
import { decryptBuffer, CryptoAuthError } from "../crypto/chunked-codec.js";
import { openCacheDb } from "../db/connection.js";
import { CorruptionError } from "../errors.js";

interface AttachRemoteOptions extends OptionValues {
  bucket: string;
  prefix: string;
  root: string;
  endpoint?: string;
  region: string;
}

interface GlobalOptions extends OptionValues {
  json?: boolean;
  verbose?: boolean;
}

export function registerAttachRemoteCommand(program: Command): void {
  program
    .command("attach_remote")
    .description(
      "Attach a local root directory to an existing backup vault (join from a new machine)",
    )
    .requiredOption("--bucket <bucket>", "S3 bucket name")
    .option("--prefix <prefix>", "S3 key prefix", "")
    .requiredOption("--root <path>", "local directory to attach")
    .option("--endpoint <url>", "S3-compatible endpoint (e.g. LocalStack); omit for real AWS S3")
    .option("--region <region>", "AWS region", "us-east-1")
    .action(async (opts: AttachRemoteOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "attach_remote" });

      try {
        const versionStamp = await runAttachRemote(opts, logger);
        if (json) {
          emitJson({
            ok: true,
            version_stamp: versionStamp,
            bucket: opts.bucket,
            prefix: normalizePrefix(opts.prefix),
            root: path.resolve(opts.root),
          });
        } else {
          process.stdout.write(
            `Attached to vault at s3://${opts.bucket}/${normalizePrefix(opts.prefix)} (version ${versionStamp}). Run 'sync' to materialize files.\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "attach_remote failed");
        emitError(json, message, exitCodeForError(err));
      }
    });
}

async function runAttachRemote(
  opts: AttachRemoteOptions,
  logger: ReturnType<typeof createLogger>,
): Promise<string> {
  const root = path.resolve(opts.root);
  const sync1DirPath = sync1Dir(root);
  if (fs.existsSync(sync1DirPath)) {
    throw new Error(`"${sync1DirPath}" already exists — this root is already attached/initialized`);
  }

  const password = await getPassword();
  const client = createS3Client({ endpoint: opts.endpoint, region: opts.region });
  const prefix = normalizePrefix(opts.prefix);
  const location: RemoteLocation = { bucket: opts.bucket, prefix };

  logger.debug({ bucket: opts.bucket, prefix }, "fetching vault manifest");
  const manifestObj = await getObject(client, opts.bucket, remoteKey(location, VAULT_MANIFEST_KEY));
  if (!manifestObj) {
    throw new Error(`no vault found at s3://${opts.bucket}/${prefix} (missing vault.json)`);
  }
  const manifest = parseManifest(manifestObj.body);

  // Fails fast and clearly on a wrong password, before touching the filesystem at all.
  const masterKey = unlockVault(manifest, password);

  logger.debug({}, "fetching /current pointer");
  const currentObj = await getObject(client, opts.bucket, remoteKey(location, CURRENT_POINTER_KEY));
  if (!currentObj) {
    throw new CorruptionError(
      `vault at s3://${opts.bucket}/${prefix} has no /current pointer (corrupt vault?)`,
    );
  }
  const versionStamp = currentObj.body.toString("utf8");

  logger.debug({ versionStamp }, "fetching current state.db snapshot");
  const snapshotObj = await getObject(
    client,
    opts.bucket,
    remoteKey(location, stateSnapshotKey(versionStamp)),
  );
  if (!snapshotObj) {
    throw new CorruptionError(
      `state.db snapshot for version "${versionStamp}" is missing (corrupt vault?)`,
    );
  }

  let stateDbBytes: Buffer;
  try {
    stateDbBytes = decryptBuffer(snapshotObj.body, masterKey);
  } catch (err) {
    if (err instanceof CryptoAuthError) {
      throw new CorruptionError(
        "state.db snapshot failed decryption/authentication (corrupted upload?)",
      );
    }
    throw err;
  }

  // No filesystem writes beyond .sync1/ itself at this stage — mirrors
  // fetch_remote's contract. Materializing the tree (as stubs) happens the
  // first time `sync` runs, not here.
  fs.mkdirSync(sync1DirPath, { recursive: true });
  fs.writeFileSync(localStateDbPath(root), stateDbBytes);
  fs.writeFileSync(localVaultJsonPath(root), manifestObj.body);
  fs.writeFileSync(lastSyncedVersionPath(root), versionStamp, "utf8");

  const remoteConfig: RemoteConfig = { bucket: opts.bucket, prefix, region: opts.region };
  if (opts.endpoint) remoteConfig.endpoint = opts.endpoint;
  fs.writeFileSync(localRemoteConfigPath(root), serializeRemoteConfig(remoteConfig));

  // cache.db is created empty (migrated) now so it's ready for the first
  // update_cache/sync run; it holds no rows yet.
  openCacheDb(localCacheDbPath(root), logger).close();

  return versionStamp;
}
