import fs from "node:fs";
import type { Command, OptionValues } from "commander";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { getPassword } from "../cli/password.js";
import { createS3Client } from "../s3/client.js";
import { parseManifest, unlockVault } from "../vault/manifest.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import {
  localCacheDbPath,
  localStateDbPath,
  localVaultJsonPath,
  localRemoteConfigPath,
} from "../vault/local-dir.js";
import { resolveRoot } from "../cli/resolve-root.js";
import { normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import { openCacheDb, openStateDbReadOnly } from "../db/connection.js";
import { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { materializeGlob, type MaterializeStats } from "../fs/materialize.js";
import { createConcurrencyPools } from "../concurrency/pools.js";
import {
  resolveConcurrencyOptions,
  type GlobalConcurrencyOptions,
} from "../cli/concurrency-options.js";
import {
  shouldShowProgress,
  startBytesProgressSession,
  createLoggerForRun,
  reporterFor,
} from "../cli/progress.js";

interface MaterializeOptions extends OptionValues {
  root?: string;
  requestRetrieval?: boolean;
}

interface GlobalOptions extends GlobalConcurrencyOptions {
  json?: boolean;
  verbose?: boolean;
  progress?: boolean;
}

export function registerMaterializeCommand(program: Command): void {
  program
    .command("materialize")
    .description("Download and materialize stub files matching a glob pattern")
    .argument("<glob>", "glob pattern matched against tracked paths")
    .option(
      "--root <path>",
      "local directory to operate on (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .option("--request-retrieval", "request temporary S3 restore for archived (cold) objects")
    .action(async (glob: string, opts: MaterializeOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const showProgress = shouldShowProgress({ json, progress: globalOpts.progress ?? true });
      const logger = createLoggerForRun({
        verbose: globalOpts.verbose ?? false,
        showProgress,
      }).child({ command: "materialize" });

      try {
        const stats = await runMaterialize(glob, opts, globalOpts, logger, showProgress);
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
        emitError(json, message, exitCodeForError(err));
      }
    });
}

async function runMaterialize(
  glob: string,
  opts: MaterializeOptions,
  globalOpts: GlobalOptions,
  logger: import("../logger.js").Logger,
  showProgress: boolean,
): Promise<MaterializeStats> {
  const root = resolveRoot(opts.root);

  const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
  const password = await getPassword();
  const manifest = parseManifest(fs.readFileSync(localVaultJsonPath(root)));
  const masterKey = unlockVault(manifest, password);

  const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
  const prefix = normalizePrefix(remoteConfig.prefix);
  const location: RemoteLocation = { bucket: remoteConfig.bucket, prefix };

  const cacheDb = openCacheDb(localCacheDbPath(root), logger);
  const stateDb = openStateDbReadOnly(localStateDbPath(root));
  const pools = createConcurrencyPools(resolveConcurrencyOptions(globalOpts));
  const progress = startBytesProgressSession({ show: showProgress, overallLabel: "materializing" });

  try {
    const cacheRepo = new CacheEntriesRepository(cacheDb);
    const objectsRepo = new ObjectsRepository(stateDb);
    // No `cacheRepo.count()` pre-seed any more: it counted every row in
    // the vault, not the glob-matched subset this run will touch, so it
    // over-stated the denominator for exactly the narrow-glob case
    // materialize is usually given. materializeGlob enumerates its own
    // real total now, before its first S3 call.
    return await materializeGlob(
      root,
      glob,
      cacheRepo,
      objectsRepo,
      masterKey,
      opts.requestRetrieval ?? false,
      { client, bucket: remoteConfig.bucket, location },
      logger,
      pools.s3,
      pools.s3.concurrency * 2,
      pools.stream,
      pools.stream.concurrency * 2,
      reporterFor(progress),
    );
  } finally {
    progress.stop();
    await pools.hash.close();
    cacheDb.close();
    stateDb.close();
  }
}
