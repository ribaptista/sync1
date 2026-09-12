import fs from "node:fs";
import path from "node:path";
import type { Command, OptionValues } from "commander";
import { createLogger, type Logger } from "../logger.js";
import { emitJson, emitError, exitCodeForError, EXIT_CONFLICT } from "../cli/output.js";
import { getPassword } from "../cli/password.js";
import { createS3Client } from "../s3/client.js";
import { parseManifest, unlockVault } from "../vault/manifest.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import { sync1Dir, localVaultJsonPath, localRemoteConfigPath } from "../vault/local-dir.js";
import { normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import { performSync, RemoteDivergedError, type SyncResult } from "../sync/commit.js";

interface SyncOptions extends OptionValues {
  root: string;
}

interface GlobalOptions extends OptionValues {
  json?: boolean;
  verbose?: boolean;
}

export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .description("Sync local changes with the remote vault")
    .requiredOption("--root <path>", "local directory to sync")
    .action(async (opts: SyncOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "sync" });

      try {
        const result = await runSync(opts, logger);
        const hasConflicts = result.conflicts.length > 0;
        const hasCaseCollisions = result.caseCollisions.length > 0;
        const hasIssues = hasConflicts || hasCaseCollisions;

        if (json) {
          emitJson({
            ok: !hasIssues,
            version_stamp: result.versionStamp,
            nothing_to_sync: result.nothingToSync,
            uploaded_objects: result.uploadedObjects,
            deduped_objects: result.dedupedObjects,
            local_entries_changed: result.localEntriesChanged,
            remote_created: result.remoteCreated,
            remote_modified: result.remoteModified,
            remote_deleted: result.remoteDeleted,
            conflicts: result.conflicts,
            case_collisions: result.caseCollisions.map((c) => ({
              path: c.path,
              collides_with: c.collidesWith,
            })),
          });
        } else if (result.nothingToSync) {
          process.stdout.write("sync: nothing to sync\n");
        } else {
          process.stdout.write(
            `sync: version ${result.versionStamp} -- ${result.uploadedObjects} objects uploaded, ${result.dedupedObjects} deduped, ${result.localEntriesChanged} local entries changed, ${result.remoteCreated} remote created, ${result.remoteModified} remote modified, ${result.remoteDeleted} remote deleted\n`,
          );
          if (hasConflicts) {
            process.stdout.write(`${result.conflicts.length} conflict(s) left unresolved:\n`);
            for (const c of result.conflicts) process.stdout.write(`  - ${c.path}: ${c.reason}\n`);
          }
          if (hasCaseCollisions) {
            process.stdout.write(
              `${result.caseCollisions.length} case-insensitive collision(s) detected (not synced):\n`,
            );
            for (const c of result.caseCollisions) {
              process.stdout.write(`  - "${c.path}" vs "${c.collidesWith}"\n`);
            }
          }
        }

        if (hasIssues) process.exitCode = EXIT_CONFLICT;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "sync failed");
        const exitCode = err instanceof RemoteDivergedError ? EXIT_CONFLICT : exitCodeForError(err);
        emitError(json, message, exitCode);
      }
    });
}

async function runSync(opts: SyncOptions, logger: Logger): Promise<SyncResult> {
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

  return performSync(root, masterKey, { client, bucket: remoteConfig.bucket, location }, logger);
}
