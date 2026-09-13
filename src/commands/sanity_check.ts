import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Command, OptionValues } from "commander";
import { emitJson, emitError, exitCodeForError, EXIT_GENERIC_ERROR } from "../cli/output.js";
import { createS3Client, headObject } from "../s3/client.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import { sync1Dir, localStateDbPath, localRemoteConfigPath } from "../vault/local-dir.js";
import { remoteKey, normalizePrefix, type RemoteLocation } from "../vault/paths.js";
import { EntriesRepository } from "../db/repositories/entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { IgnorePoliciesRepository } from "../db/repositories/ignore-policies-repository.js";
import { performSanityCheck, type SanityCheckResult } from "../fs/sanity-check.js";
import { createConcurrencyPools } from "../concurrency/pools.js";
import {
  resolveConcurrencyOptions,
  type GlobalConcurrencyOptions,
} from "../cli/concurrency-options.js";
import { shouldShowProgress, startProgressSession, createLoggerForRun } from "../cli/progress.js";

interface SanityCheckOptions extends OptionValues {
  root: string;
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
    result.missingLocally.length +
    result.untracked.length
  );
}

export function registerSanityCheckCommand(program: Command): void {
  program
    .command("sanity_check")
    .description(
      "Read-only diagnostic: cross-checks state.db against S3 and the local filesystem for bugs (never repairs anything)",
    )
    .requiredOption("--root <path>", "local directory to check")
    .option("--filter <glob>", "SQLite GLOB pattern scoping which tracked paths to check")
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
            missing_locally: result.missingLocally,
            untracked: result.untracked,
            ignored_count: result.ignoredCount,
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
          if (result.missingLocally.length > 0) {
            process.stdout.write("  tracked but missing locally:\n");
            for (const p of result.missingLocally) process.stdout.write(`    - ${p}\n`);
          }
          if (result.untracked.length > 0) {
            process.stdout.write("  untracked local files:\n");
            for (const p of result.untracked) process.stdout.write(`    - ${p}\n`);
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
  const root = path.resolve(opts.root);
  const sync1DirPath = sync1Dir(root);
  if (!fs.existsSync(sync1DirPath)) {
    throw new Error(`"${sync1DirPath}" does not exist — run init_remote or attach_remote first`);
  }

  const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
  const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
  const prefix = normalizePrefix(remoteConfig.prefix);
  const location: RemoteLocation = { bucket: remoteConfig.bucket, prefix };

  // Single connection: entriesRepo.iterateAllSortedByPath() is
  // keyset-paginated (src/db/keyset-pagination.ts), not a live `.iterate()`
  // cursor, so the connection is free between pages -- objectsRepo and
  // ignorePoliciesRepo can safely be queried mid-loop on the same
  // connection now, unlike when this held a real cursor open throughout.
  const db = new Database(localStateDbPath(root), { readonly: true, fileMustExist: true });
  const pools = createConcurrencyPools(resolveConcurrencyOptions(globalOpts));
  const progress = startProgressSession({
    show: showProgress,
    overallLabel: "checking",
    overallUnit: "entries",
  });

  try {
    const entriesRepo = new EntriesRepository(db);
    const objectsRepo = new ObjectsRepository(db);
    const ignorePoliciesRepo = new IgnorePoliciesRepository(db);

    const objectExists = async (s3Key: string): Promise<boolean> => {
      const head = await headObject(client, remoteConfig.bucket, remoteKey(location, s3Key));
      return head !== null;
    };

    return await performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      objectExists,
      logger,
      pools.hash,
      pools.hash.maxThreads,
      pools.s3,
      pools.s3.concurrency * 2,
      opts.filter,
      (n) => {
        progress.setOverallTotal(n);
        progress.advanceOverall(1);
      },
    );
  } finally {
    progress.stop();
    await pools.hash.close();
    db.close();
  }
}
