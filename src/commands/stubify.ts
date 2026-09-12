import fs from "node:fs";
import path from "node:path";
import type { Command, OptionValues } from "commander";
import { createLogger, type Logger } from "../logger.js";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { sync1Dir, localCacheDbPath } from "../vault/local-dir.js";
import { openCacheDb } from "../db/connection.js";
import { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import { stubifyGlob, type StubifyStats } from "../fs/stubify.js";

interface StubifyOptions extends OptionValues {
  root: string;
}

interface GlobalOptions extends OptionValues {
  json?: boolean;
  verbose?: boolean;
}

export function registerStubifyCommand(program: Command): void {
  program
    .command("stubify")
    .description("Replace fully-committed real files matching a glob pattern with stubs")
    .argument("<glob>", "SQLite GLOB pattern matched against tracked paths")
    .requiredOption("--root <path>", "local directory to operate on")
    .action(async (glob: string, opts: StubifyOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "stubify" });

      try {
        const stats = await runStubify(glob, opts, logger);
        if (json) {
          emitJson({
            ok: stats.skipped.length === 0,
            stubified: stats.stubified,
            already_stub: stats.alreadyStub,
            skipped: stats.skipped,
          });
        } else {
          process.stdout.write(
            `stubify: ${stats.stubified} stubified, ${stats.alreadyStub} already stub\n`,
          );
          for (const s of stats.skipped) process.stdout.write(`  skipped ${s.path}: ${s.reason}\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "stubify failed");
        emitError(json, message, exitCodeForError(err));
      }
    });
}

async function runStubify(
  glob: string,
  opts: StubifyOptions,
  logger: Logger,
): Promise<StubifyStats> {
  const root = path.resolve(opts.root);
  const sync1DirPath = sync1Dir(root);
  if (!fs.existsSync(sync1DirPath)) {
    throw new Error(`"${sync1DirPath}" does not exist — run init_remote or attach_remote first`);
  }

  const cacheDb = openCacheDb(localCacheDbPath(root), logger);
  try {
    const cacheRepo = new CacheEntriesRepository(cacheDb);
    return await stubifyGlob(root, glob, cacheRepo, logger);
  } finally {
    cacheDb.close();
  }
}
