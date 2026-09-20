import fs from "node:fs";
import type { Command, OptionValues } from "commander";
import { createLogger, type Logger } from "../logger.js";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { getPassword } from "../cli/password.js";
import { createS3Client, getObject } from "../s3/client.js";
import { parseManifest, unlockVault } from "../vault/manifest.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import { localVaultJsonPath, localRemoteConfigPath, localStateDbPath } from "../vault/local-dir.js";
import { resolveRoot } from "../cli/resolve-root.js";
import {
  remoteKey,
  normalizePrefix,
  stateSnapshotKey,
  CURRENT_POINTER_KEY,
  type RemoteLocation,
} from "../vault/paths.js";
import { decryptBuffer, CryptoAuthError } from "../crypto/chunked-codec.js";
import { CorruptionError } from "../errors.js";
import { writeFileWithRetry } from "../fs/safe-fs.js";

interface FetchRemoteOptions extends OptionValues {
  root?: string;
}

interface GlobalOptions extends OptionValues {
  json?: boolean;
  verbose?: boolean;
}

export function registerFetchRemoteCommand(program: Command): void {
  program
    .command("fetch_remote")
    .description("Fetch the latest state.db from the remote vault (no filesystem/cache.db changes)")
    .option(
      "--root <path>",
      "local directory whose vault to fetch (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .action(async (opts: FetchRemoteOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "fetch_remote" });

      try {
        const versionStamp = await runFetchRemote(opts, logger);
        if (json) {
          emitJson({ ok: true, version_stamp: versionStamp });
        } else {
          process.stdout.write(`fetch_remote: local state.db is now at version ${versionStamp}\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "fetch_remote failed");
        emitError(json, message, exitCodeForError(err));
      }
    });
}

async function runFetchRemote(opts: FetchRemoteOptions, logger: Logger): Promise<string> {
  const root = resolveRoot(opts.root);

  const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
  const password = await getPassword();
  const manifest = parseManifest(fs.readFileSync(localVaultJsonPath(root)));
  const masterKey = unlockVault(manifest, password);

  const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
  const prefix = normalizePrefix(remoteConfig.prefix);
  const location: RemoteLocation = { bucket: remoteConfig.bucket, prefix };

  logger.debug({}, "fetching /current pointer");
  const current = await getObject(
    client,
    remoteConfig.bucket,
    remoteKey(location, CURRENT_POINTER_KEY),
  );
  if (!current) throw new CorruptionError("vault has no /current pointer (corrupt vault?)");
  const versionStamp = current.body.toString("utf8");

  logger.debug({ versionStamp }, "fetching state.db snapshot");
  const snapshot = await getObject(
    client,
    remoteConfig.bucket,
    remoteKey(location, stateSnapshotKey(versionStamp)),
  );
  if (!snapshot)
    throw new CorruptionError(`state.db snapshot for version "${versionStamp}" is missing`);

  let decrypted: Buffer;
  try {
    decrypted = decryptBuffer(snapshot.body, masterKey);
  } catch (err) {
    if (err instanceof CryptoAuthError) {
      throw new CorruptionError(
        "state.db snapshot failed decryption/authentication (corrupted upload?)",
      );
    }
    throw err;
  }

  // No filesystem or cache.db changes -- only state.db, mirroring
  // attach_remote's contract. Deliberately does NOT touch last_synced_version
  // either: that file records what this machine has *synced* (folded local
  // changes into), not merely fetched -- sync is what advances it.
  await writeFileWithRetry(localStateDbPath(root), decrypted);

  return versionStamp;
}
