import fs from "node:fs";
import path from "node:path";
import type { Command, OptionValues } from "commander";
import { createLogger, type Logger } from "../logger.js";
import { emitJson, emitError } from "../cli/output.js";
import { getPassword } from "../cli/password.js";
import { createS3Client } from "../s3/client.js";
import { parseManifest, unlockVault } from "../vault/manifest.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import { sync1Dir, localVaultJsonPath, localRemoteConfigPath } from "../vault/local-dir.js";
import { normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import { performGc, type GcResult } from "../sync/gc.js";

interface GcOptions extends OptionValues {
  root: string;
  apply?: boolean;
}

interface GlobalOptions extends OptionValues {
  json?: boolean;
  verbose?: boolean;
}

export function registerGcCommand(program: Command): void {
  program
    .command("gc")
    .description("Remove S3 objects no longer referenced by any current entry")
    .requiredOption("--root <path>", "local directory whose vault to clean up")
    .option("--apply", "actually delete orphaned objects (default: count only)")
    .action(async (opts: GcOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "gc" });

      try {
        const result = await runGc(opts, logger);
        if (json) {
          emitJson({
            ok: true,
            applied: result.applied,
            orphan_count: result.orphanCount,
            reclaimed_bytes: result.reclaimedBytes,
          });
        } else {
          const mode = result.applied ? "removed" : "counted (pass --apply to remove)";
          process.stdout.write(
            `gc (${mode}): ${result.orphanCount} orphans, ${result.reclaimedBytes} bytes\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "gc failed");
        emitError(json, message);
      }
    });
}

async function runGc(opts: GcOptions, logger: Logger): Promise<GcResult> {
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

  return performGc(
    root,
    masterKey,
    { client, bucket: remoteConfig.bucket, location },
    opts.apply ?? false,
    logger,
  );
}
