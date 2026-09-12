import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Command, OptionValues } from "commander";
import { createLogger, type Logger } from "../logger.js";
import { emitJson, emitError } from "../cli/output.js";
import { sync1Dir, localCacheDbPath, localStateDbPath } from "../vault/local-dir.js";
import { openCacheDb } from "../db/connection.js";
import { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import { EntriesRepository } from "../db/repositories/entries-repository.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { VersionsRepository } from "../db/repositories/versions-repository.js";

interface InspectOptions extends OptionValues {
  root: string;
}

interface GlobalOptions extends OptionValues {
  json?: boolean;
  verbose?: boolean;
}

export interface InspectCacheView {
  hash: string | null;
  mtime: number | null;
  state: string;
}

export interface InspectStateView {
  hash: string | null;
  state_version: string;
  sequence: number | null;
  size: number | null;
}

export interface InspectResult {
  path: string;
  cache: InspectCacheView | null;
  state: InspectStateView | null;
}

const GLOB_CHARS = /[*?[\]]/;

export function registerInspectCommand(program: Command): void {
  program
    .command("inspect")
    .description(
      "Query cache.db/state.db for a path or SQLite GLOB pattern, as JSON -- meant for scripting and other tools built on top of this vault",
    )
    .argument("<path-or-glob>", "an exact tracked path, or a SQLite GLOB pattern")
    .requiredOption("--root <path>", "local directory to inspect")
    .action(async (pathOrGlob: string, opts: InspectOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "inspect" });

      try {
        const results = await runInspect(pathOrGlob, opts, logger);
        if (json) {
          for (const r of results) emitJson(r);
        } else {
          for (const r of results) {
            const cacheDesc = r.cache ? `cache=${r.cache.state}` : "cache=untracked";
            const stateDesc = r.state ? `state@seq${r.state.sequence}` : "state=untracked";
            process.stdout.write(`${r.path}: ${cacheDesc}, ${stateDesc}\n`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "inspect failed");
        emitError(json, message);
      }
    });
}

async function runInspect(
  pathOrGlob: string,
  opts: InspectOptions,
  logger: Logger,
): Promise<InspectResult[]> {
  const root = path.resolve(opts.root);
  const sync1DirPath = sync1Dir(root);
  if (!fs.existsSync(sync1DirPath)) {
    throw new Error(`"${sync1DirPath}" does not exist — run init_remote or attach_remote first`);
  }

  const cacheDb = openCacheDb(localCacheDbPath(root), logger);
  const stateDb = new Database(localStateDbPath(root), { readonly: true, fileMustExist: true });

  try {
    const cacheRepo = new CacheEntriesRepository(cacheDb);
    const entriesRepo = new EntriesRepository(stateDb);
    const objectsRepo = new ObjectsRepository(stateDb);
    const versionsRepo = new VersionsRepository(stateDb);

    const isGlob = GLOB_CHARS.test(pathOrGlob);
    let paths: string[];
    if (isGlob) {
      const pathSet = new Set<string>();
      for (const row of cacheRepo.iterateByGlobSortedByPath(pathOrGlob)) pathSet.add(row.path);
      for (const row of entriesRepo.iterateByGlobSortedByPath(pathOrGlob)) pathSet.add(row.path);
      paths = [...pathSet].sort();
    } else {
      // An exact path always yields exactly one result, populated or null on
      // each side -- this is what lets a caller distinguish "never synced"
      // from "synced but not locally tracked" instead of getting nothing back.
      paths = [pathOrGlob];
    }

    return paths.map((p) => {
      const cacheRow = cacheRepo.get(p);
      const entryRow = entriesRepo.get(p);

      let state: InspectStateView | null = null;
      if (entryRow) {
        const versionRow = versionsRepo.getByVersionStamp(entryRow.state_version);
        const objectRow = entryRow.hash ? objectsRepo.get(entryRow.hash) : undefined;
        state = {
          hash: entryRow.hash,
          state_version: entryRow.state_version,
          sequence: versionRow?.sequence ?? null,
          size: objectRow?.size ?? null,
        };
      }

      return {
        path: p,
        cache: cacheRow
          ? { hash: cacheRow.hash, mtime: cacheRow.mtime, state: cacheRow.state }
          : null,
        state,
      };
    });
  } finally {
    cacheDb.close();
    stateDb.close();
  }
}
