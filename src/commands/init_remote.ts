import fs from "node:fs";
import path from "node:path";
import type { Command, OptionValues } from "commander";
import sodium from "sodium-native";
import { createLogger } from "../logger.js";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { getPassword } from "../cli/password.js";
import { createS3Client, putObjectCas, isPrefixEmpty } from "../s3/client.js";
import { createVaultManifest, serializeManifest } from "../vault/manifest.js";
import { generateVersionStamp } from "../vault/version-stamp.js";
import {
  sync1Dir,
  localStateDbPath,
  localVaultJsonPath,
  localRemoteConfigPath,
  lastSyncedVersionPath,
} from "../vault/local-dir.js";
import { serializeRemoteConfig, type RemoteConfig } from "../vault/remote-config.js";
import {
  remoteKey,
  normalizePrefix,
  VAULT_MANIFEST_KEY,
  CURRENT_POINTER_KEY,
  stateSnapshotKey,
  type RemoteLocation,
} from "../vault/paths.js";
import { openStateDb } from "../db/connection.js";
import { VersionsRepository } from "../db/repositories/versions-repository.js";
import { encryptBuffer } from "../crypto/chunked-codec.js";

interface InitRemoteOptions extends OptionValues {
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

export function registerInitRemoteCommand(program: Command): void {
  program
    .command("init_remote")
    .description("Create a new backup vault in S3 for a local root directory")
    .requiredOption("--bucket <bucket>", "S3 bucket name")
    .option("--prefix <prefix>", "S3 key prefix", "")
    .requiredOption("--root <path>", "local directory to back up")
    .option("--endpoint <url>", "S3-compatible endpoint (e.g. LocalStack); omit for real AWS S3")
    .option("--region <region>", "AWS region", "us-east-1")
    .action(async (opts: InitRemoteOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "init_remote" });

      try {
        const versionStamp = await runInitRemote(opts, logger);
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
            `Initialized new vault at s3://${opts.bucket}/${normalizePrefix(opts.prefix)} (version ${versionStamp})\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "init_remote failed");
        emitError(json, message, exitCodeForError(err));
      }
    });
}

async function runInitRemote(
  opts: InitRemoteOptions,
  logger: ReturnType<typeof createLogger>,
): Promise<string> {
  const root = path.resolve(opts.root);
  const sync1DirPath = sync1Dir(root);
  if (fs.existsSync(sync1DirPath)) {
    throw new Error(`"${sync1DirPath}" already exists — this root is already initialized`);
  }

  const password = await getPassword();
  const client = createS3Client({ endpoint: opts.endpoint, region: opts.region });
  const prefix = normalizePrefix(opts.prefix);
  const location: RemoteLocation = { bucket: opts.bucket, prefix };

  logger.debug({ bucket: opts.bucket, prefix }, "checking S3 location is empty");
  const empty = await isPrefixEmpty(client, opts.bucket, prefix);
  if (!empty) {
    throw new Error(
      `s3://${opts.bucket}/${prefix} is not empty — refusing to init a new vault here`,
    );
  }

  const { manifest, masterKey } = createVaultManifest(password);
  const versionStamp = generateVersionStamp();
  logger.debug({ versionStamp }, "generated initial version stamp");

  fs.mkdirSync(sync1DirPath, { recursive: true });
  const stateDbPath = localStateDbPath(root);
  const db = openStateDb(stateDbPath, logger);
  new VersionsRepository(db).insert(versionStamp, new Date().toISOString());
  db.close(); // checkpoints WAL so the file on disk is complete before we read it back

  const stateDbBytes = fs.readFileSync(stateDbPath);
  const stateContext = Buffer.alloc(16);
  sodium.randombytes_buf(stateContext); // random, non-convergent (state.db isn't content-addressed)
  const encryptedStateDb = encryptBuffer(stateDbBytes, masterKey, stateContext);

  logger.debug({ key: VAULT_MANIFEST_KEY }, "uploading vault manifest");
  await putObjectCas(
    client,
    opts.bucket,
    remoteKey(location, VAULT_MANIFEST_KEY),
    serializeManifest(manifest),
    { ifNoneMatchAny: true },
  );

  logger.debug({ versionStamp }, "uploading initial state.db snapshot");
  await putObjectCas(
    client,
    opts.bucket,
    remoteKey(location, stateSnapshotKey(versionStamp)),
    encryptedStateDb,
    { ifNoneMatchAny: true },
  );

  logger.debug({ versionStamp }, "publishing /current pointer");
  await putObjectCas(
    client,
    opts.bucket,
    remoteKey(location, CURRENT_POINTER_KEY),
    Buffer.from(versionStamp, "utf8"),
    { ifNoneMatchAny: true },
  );

  fs.writeFileSync(lastSyncedVersionPath(root), versionStamp, "utf8");
  fs.writeFileSync(localVaultJsonPath(root), serializeManifest(manifest));

  const remoteConfig: RemoteConfig = { bucket: opts.bucket, prefix, region: opts.region };
  if (opts.endpoint) remoteConfig.endpoint = opts.endpoint;
  fs.writeFileSync(localRemoteConfigPath(root), serializeRemoteConfig(remoteConfig));

  return versionStamp;
}
