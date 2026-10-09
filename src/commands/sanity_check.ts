import fs from "node:fs";
import type { Command, OptionValues } from "commander";
import { openStateDbReadOnly } from "../db/connection.js";
import { emitJson, emitError, exitCodeForError, EXIT_GENERIC_ERROR } from "../cli/output.js";
import { createS3Client, headObject } from "../s3/client.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import { localStateDbPath, localRemoteConfigPath, localVaultJsonPath } from "../vault/local-dir.js";
import { parseManifest, unlockVault } from "../vault/manifest.js";
import { getPassword } from "../cli/password.js";
import { encryptFileForObject } from "../fs/encrypt-file.js";
import { resolveRoot } from "../cli/resolve-root.js";
import { remoteKey, normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import { EntriesRepository } from "../db/repositories/entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { IgnorePoliciesRepository } from "../db/repositories/ignore-policies-repository.js";
import {
  performSanityCheck,
  type ObjectHeadChecker,
  type LocalReader,
  type SanityCheckResult,
} from "../fs/sanity-check.js";
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

interface SanityCheckOptions extends OptionValues {
  root?: string;
  filter?: string;
}

interface GlobalOptions extends GlobalConcurrencyOptions {
  json?: boolean;
  verbose?: boolean;
  progress?: boolean;
}

function problemCount(result: SanityCheckResult): number {
  return (
    result.bothStubAndReal.length +
    result.hashMismatch.length +
    result.stubMismatch.length +
    result.missingInS3.length +
    result.checksumMismatch.length +
    result.missingLocally.length +
    result.untracked.length +
    result.staleTempFiles.length
  );
}

export function registerSanityCheckCommand(program: Command): void {
  program
    .command("sanity_check")
    .description(
      "Read-only diagnostic: cross-checks state.db, S3 (existence and ciphertext checksums), and the local filesystem for bugs (never repairs anything)",
    )
    .option(
      "--root <path>",
      "local directory to check (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .option("--filter <glob>", "glob pattern scoping which tracked paths to check")
    .action(async (opts: SanityCheckOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const showProgress = shouldShowProgress({ json, progress: globalOpts.progress ?? true });
      const logger = createLoggerForRun({
        verbose: globalOpts.verbose ?? false,
        showProgress,
      }).child({ command: "sanity_check" });

      try {
        const result = await runSanityCheck(opts, globalOpts, logger, showProgress);
        const problems = problemCount(result);
        const ok = problems === 0;

        if (json) {
          emitJson({
            ok,
            both_stub_and_real: result.bothStubAndReal,
            hash_mismatch: result.hashMismatch.map((m) => ({
              path: m.path,
              expected_hash: m.expectedHash,
              actual_hash: m.actualHash,
            })),
            stub_mismatch: result.stubMismatch,
            missing_in_s3: result.missingInS3,
            checksum_mismatch: result.checksumMismatch.map((m) => ({
              path: m.path,
              hash: m.hash,
              local_checksum: m.localChecksum,
              recorded_checksum: m.recordedChecksum,
              s3_checksum: m.s3Checksum,
            })),
            missing_locally: result.missingLocally,
            untracked: result.untracked,
            ignored_count: result.ignoredCount,
            stale_temp_files: result.staleTempFiles,
          });
        } else {
          process.stdout.write(
            `sanity_check: ${problems} problem(s) found (${result.ignoredCount} untracked path(s) skipped via ignore policy)\n`,
          );
          if (result.bothStubAndReal.length > 0) {
            process.stdout.write("  both a stub and the real file present:\n");
            for (const p of result.bothStubAndReal) process.stdout.write(`    - ${p}\n`);
          }
          if (result.hashMismatch.length > 0) {
            process.stdout.write("  content hash mismatch:\n");
            for (const m of result.hashMismatch) {
              process.stdout.write(
                `    - ${m.path} (expected ${m.expectedHash}, actual ${m.actualHash})\n`,
              );
            }
          }
          if (result.stubMismatch.length > 0) {
            process.stdout.write("  stub problems:\n");
            for (const m of result.stubMismatch) {
              process.stdout.write(`    - ${m.path}: ${m.reason}\n`);
            }
          }
          if (result.missingInS3.length > 0) {
            process.stdout.write("  missing in S3:\n");
            for (const m of result.missingInS3) {
              process.stdout.write(`    - ${m.path} (hash ${m.hash})\n`);
            }
          }
          if (result.checksumMismatch.length > 0) {
            process.stdout.write(
              "  ciphertext checksum disagreement (local re-encrypt / state.db / S3 HEAD):\n",
            );
            for (const m of result.checksumMismatch) {
              process.stdout.write(
                `    - ${m.path} (local ${m.localChecksum ?? "n/a"}, recorded ${m.recordedChecksum}, s3 ${m.s3Checksum ?? "none"})\n`,
              );
            }
          }
          if (result.missingLocally.length > 0) {
            process.stdout.write("  tracked but missing locally:\n");
            for (const p of result.missingLocally) process.stdout.write(`    - ${p}\n`);
          }
          if (result.untracked.length > 0) {
            process.stdout.write("  untracked local files:\n");
            for (const p of result.untracked) process.stdout.write(`    - ${p}\n`);
          }
          if (result.staleTempFiles.length > 0) {
            const total = result.staleTempFiles.reduce((sum, t) => sum + t.size, 0);
            process.stdout.write(
              `  stale in-tree temp files (${total} bytes total) -- leftovers from an interrupted run; nothing removes these automatically, so delete them once you're sure no sync1 command is running:\n`,
            );
            for (const t of result.staleTempFiles) {
              process.stdout.write(`    - ${t.path} (${t.size} bytes)\n`);
            }
          }
        }

        if (!ok) process.exitCode = EXIT_GENERIC_ERROR;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "sanity_check failed");
        emitError(json, message, exitCodeForError(err));
      }
    });
}

async function runSanityCheck(
  opts: SanityCheckOptions,
  globalOpts: GlobalOptions,
  logger: import("../logger.js").Logger,
  showProgress: boolean,
): Promise<SanityCheckResult> {
  const root = resolveRoot(opts.root);

  const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
  // Needed only to re-encrypt a local file for its ciphertext checksum;
  // nothing here is ever decrypted. Unlocked before anything else so a
  // wrong password fails immediately, not partway through the scan.
  const password = await getPassword();
  const manifest = parseManifest(fs.readFileSync(localVaultJsonPath(root)));
  const masterKey = unlockVault(manifest, password);
  const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
  const prefix = normalizePrefix(remoteConfig.prefix);
  const location: RemoteLocation = { bucket: remoteConfig.bucket, prefix };

  // Single connection: entriesRepo.iterateAllSortedByPath() is
  // keyset-paginated (src/db/keyset-pagination.ts), not a live `.iterate()`
  // cursor, so the connection is free between pages -- objectsRepo and
  // ignorePoliciesRepo can safely be queried mid-loop on the same
  // connection now, unlike when this held a real cursor open throughout.
  const db = openStateDbReadOnly(localStateDbPath(root));
  const pools = createConcurrencyPools(resolveConcurrencyOptions(globalOpts));
  const progress = startBytesProgressSession({ show: showProgress, overallLabel: "checking" });

  try {
    const entriesRepo = new EntriesRepository(db);
    const objectsRepo = new ObjectsRepository(db);
    const ignorePoliciesRepo = new IgnorePoliciesRepository(db);
    // No `entriesRepo.count()` pre-seed any more: it counted tracked rows
    // only -- never the untracked filesystem paths the merge-join also
    // walks -- and said nothing at all about bytes, which is what actually
    // drives the bar and the ETA. performSanityCheck enumerates both for
    // real now, concurrently with the merge-join itself.

    const objectHead: ObjectHeadChecker = (s3Key) =>
      headObject(client, remoteConfig.bucket, remoteKey(location, s3Key));

    // Bound to the vault's master key -- the single read that produces
    // both the file's actual BLAKE2b hash and (since encryption is
    // convergent) the CRC64NVME it would upload as. See src/fs/
    // encrypt-file.ts and docs/architecture/vault-and-encryption.md.
    const readLocal: LocalReader = async (absolutePath, size, hash, onBytes) => {
      const { ciphertext, result } = encryptFileForObject(absolutePath, size, masterKey, hash, {
        onBytes,
        hashMismatch: "report",
        checksum: true,
      });
      // Drained to nothing -- this call only wants the two checksums
      // `result` resolves with, never the ciphertext bytes themselves.
      ciphertext.resume();
      const { plaintextHash, ciphertextChecksum } = await result;
      return { plaintextHash, ciphertextChecksum: ciphertextChecksum! };
    };

    return await performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      objectHead,
      readLocal,
      logger,
      pools.stream,
      pools.stream.concurrency * 2,
      pools.s3,
      pools.s3.concurrency * 2,
      opts.filter,
      reporterFor(progress),
    );
  } finally {
    progress.stop();
    await pools.hash.close();
    db.close();
  }
}
