import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Command, OptionValues } from "commander";
import { createLogger, type Logger } from "../logger.js";
import { emitJson, emitError } from "../cli/output.js";
import { getPassword } from "../cli/password.js";
import { createS3Client } from "../s3/client.js";
import { parseManifest, unlockVault } from "../vault/manifest.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import {
  sync1Dir,
  localCacheDbPath,
  localStateDbPath,
  localVaultJsonPath,
  localRemoteConfigPath,
} from "../vault/local-dir.js";
import { normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import { openCacheDb } from "../db/connection.js";
import { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { materializeGlob, type MaterializeStats } from "../fs/materialize.js";

interface MaterializeOptions extends OptionValues {
  root: string;
  requestRetrieval?: boolean;
}

interface GlobalOptions extends OptionValues {
  json?: boolean;
  verbose?: boolean;
}

export function registerMaterializeCommand(program: Command): void {
  program
    .command("materialize")
    .description("Download and materialize stub files matching a glob pattern")
    .argument("<glob>", "SQLite GLOB pattern matched against tracked paths")
    .requiredOption("--root <path>", "local directory to operate on")
    .option("--request-retrieval", "request temporary S3 restore for archived (cold) objects")
    .action(async (glob: string, opts: MaterializeOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "materialize" });

      try {
        const stats = await runMaterialize(glob, opts, logger);
        if (json) {
          emitJson({
            ok: true,
            materialized: stats.materialized,
            already_real: stats.alreadyReal,
            needs_retrieval: stats.needsRetrieval,
            retrieval_requested: stats.retrievalRequested,
            pending: stats.pending,
          });
        } else {
          process.stdout.write(
            `materialize: ${stats.materialized} materialized, ${stats.alreadyReal} already real, ${stats.needsRetrieval} need retrieval (pass --request-retrieval), ${stats.retrievalRequested} retrieval requested, ${stats.pending} pending\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "materialize failed");
        emitError(json, message);
      }
    });
}

async function runMaterialize(
  glob: string,
  opts: MaterializeOptions,
  logger: Logger,
): Promise<MaterializeStats> {
  const root = path.resolve(opts.root);
  const sync1DirPath = sync1Dir(root);
  if (!fs.existsSync(sync1DirPath)) {
    throw new Error(`"${sync1DirPath}" does not exist — run init_remote or attach_remote first`);
  }

  const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
  const password = await getPassword();
  const manifest = parseManifest(fs.readFileSync(localVaultJsonPath(root)));
  const masterKey = unlockVault(manifest, password);

  const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
  const prefix = normalizePrefix(remoteConfig.prefix);
  const location: RemoteLocation = { bucket: remoteConfig.bucket, prefix };

  const cacheDb = openCacheDb(localCacheDbPath(root), logger);
  const stateDb = new Database(localStateDbPath(root), { readonly: true, fileMustExist: true });

  try {
    const cacheRepo = new CacheEntriesRepository(cacheDb);
    const objectsRepo = new ObjectsRepository(stateDb);
    return await materializeGlob(
      root,
      glob,
      cacheRepo,
      objectsRepo,
      masterKey,
      opts.requestRetrieval ?? false,
      { client, bucket: remoteConfig.bucket, location },
      logger,
    );
  } finally {
    cacheDb.close();
    stateDb.close();
  }
}
