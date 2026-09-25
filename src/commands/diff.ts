import fs from "node:fs";
import type { Command, OptionValues } from "commander";
import { createLogger } from "../logger.js";
import { emitJson, emitError, exitCodeForError } from "../cli/output.js";
import { localCacheDbPath } from "../vault/local-dir.js";
import { openCacheDbReadOnly } from "../db/connection.js";
import {
  CacheEntriesRepository,
  type CacheEntryRow,
} from "../db/repositories/cache-entries-repository.js";
import { matchesAnyGlob } from "../fs/glob-match.js";
import { resolveRoot } from "../cli/resolve-root.js";

interface DiffOptions extends OptionValues {
  root?: string;
  glob?: string;
}

interface GlobalOptions extends OptionValues {
  json?: boolean;
  verbose?: boolean;
}

interface DiffCounts {
  created: number;
  modified: number;
  deleted: number;
}

/**
 * Reports what a `sync` would commit: every cache.db row whose state isn't
 * 'unchanged'.
 *
 * Reads **cache.db alone**, and read-only -- no state.db, no S3 client, no
 * password. The `state` column already *is* the diff, computed by
 * `update_cache` when it last walked the tree, so this needs nothing but a
 * single paginated query over it. The flip side, which the docs and
 * `--help` both say outright: this reports what that walk recorded, not
 * what is on disk right now. Unlike `git status` it does not scan, so it is
 * exactly as current as the last `update_cache`.
 *
 * Streams and counts as rows arrive rather than collecting them:
 * `iterateDirty()` is keyset-paginated, and a first sync leaves every row
 * in the vault dirty (tens of thousands), so buffering them to sort or
 * total would be an unbounded accumulation for no gain. That also fixes the
 * ordering as `iterateDirty`'s own -- deletions first, then the rest, each
 * path-sorted -- which is the order `sync` itself applies them in.
 */
function runDiff(opts: DiffOptions, emitRow: (row: CacheEntryRow) => void): DiffCounts {
  const root = resolveRoot(opts.root);

  // No cache.db means `update_cache` has never run here. Reporting zero
  // would read as "nothing has changed" when the truth is "nothing has
  // been looked at" -- the one confusion this command most needs to avoid,
  // since everything it reports is a recording rather than a fresh scan.
  const cacheDbPath = localCacheDbPath(root);
  if (!fs.existsSync(cacheDbPath)) {
    throw new Error(
      `no cache.db in "${root}" -- run \`sync1 update_cache\` first, since diff reports what that scan recorded`,
    );
  }

  const cacheDb = openCacheDbReadOnly(cacheDbPath);

  try {
    const cacheRepo = new CacheEntriesRepository(cacheDb);
    const counts: DiffCounts = { created: 0, modified: 0, deleted: 0 };

    for (const row of cacheRepo.iterateDirty()) {
      if (opts.glob && !matchesAnyGlob(row.path, [opts.glob]).matched) continue;
      tally(counts, row.state);
      emitRow(row);
    }
    return counts;
  } finally {
    cacheDb.close();
  }
}

function tally(counts: DiffCounts, state: CacheEntryRow["state"]): void {
  if (state === "created") counts.created++;
  else if (state === "modified") counts.modified++;
  else if (state === "deleted") counts.deleted++;
}

export function registerDiffCommand(program: Command): void {
  program
    .command("diff")
    .description(
      "List local changes a sync would commit -- as last recorded by update_cache, not a fresh scan",
    )
    .option(
      "--root <path>",
      "local directory to report on (defaults to the nearest ancestor directory with a .sync1/)",
    )
    .option("--glob <pattern>", "glob pattern scoping which paths to report")
    .action((opts: DiffOptions, command: Command) => {
      const globalOpts = command.optsWithGlobals<GlobalOptions>();
      const json = globalOpts.json ?? false;
      const logger = createLogger(globalOpts.verbose ?? false).child({ command: "diff" });

      try {
        // JSONL, following `inspect`'s precedent for a per-row result: one
        // object per change, then a summary object last. Written as each
        // row arrives, so nothing is buffered to print later.
        const emitRow = json
          ? (row: CacheEntryRow): void =>
              emitJson({
                path: row.path,
                state: row.state,
                type: row.type,
                hash: row.hash,
                size: row.size,
                parent_state_version: row.parent_state_version,
              })
          : (row: CacheEntryRow): void => {
              process.stdout.write(`${row.state.padEnd(9)} ${row.path}\n`);
            };

        const counts = runDiff(opts, emitRow);
        const total = counts.created + counts.modified + counts.deleted;

        if (json) {
          emitJson({ ok: true, ...counts, total });
        } else {
          process.stdout.write(
            `diff: ${counts.created} created, ${counts.modified} modified, ` +
              `${counts.deleted} deleted (${total} pending)\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "diff failed");
        emitError(json, message, exitCodeForError(err));
      }
    });
}
