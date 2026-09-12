import path from "node:path";
import type { Logger } from "../logger.js";
import { walk, type WalkEntry } from "./walker.js";
import { hashFile } from "./hash-file.js";
import { readStubHash, stubPathFor, StubFormatError } from "./stub.js";
import { matchesAnyGlob } from "./glob-match.js";
import type { EntriesRepository, EntryRow } from "../db/repositories/entries-repository.js";
import type { ObjectsRepository } from "../db/repositories/objects-repository.js";
import type { IgnorePoliciesRepository } from "../db/repositories/ignore-policies-repository.js";

export interface HashMismatch {
  path: string;
  expectedHash: string;
  actualHash: string;
}

export interface StubProblem {
  path: string;
  reason: string;
}

export interface MissingInS3 {
  path: string;
  hash: string;
}

export interface SanityCheckResult {
  /** Both a stub and the real file present for the same path -- a bad state, never auto-cleaned here. */
  bothStubAndReal: string[];
  hashMismatch: HashMismatch[];
  stubMismatch: StubProblem[];
  missingInS3: MissingInS3[];
  /** Tracked in state.db, but neither a stub nor a real file exists locally at all. */
  missingLocally: string[];
  /** Present locally, not tracked in state.db, and not matched by any ignore policy. */
  untracked: string[];
  /** Present locally, not tracked, but excluded because an ignore policy matches -- not a problem. */
  ignoredCount: number;
}

/**
 * Checks whether the object a hash refers to still verifiably exists in
 * S3 -- injected rather than taking an S3 client directly, so the merge-
 * join's classification logic (this module's actual complexity) can be
 * unit-tested without a real or mocked S3 client.
 */
export type ObjectExistsChecker = (s3Key: string) => Promise<boolean>;

function emptyResult(): SanityCheckResult {
  return {
    bothStubAndReal: [],
    hashMismatch: [],
    stubMismatch: [],
    missingInS3: [],
    missingLocally: [],
    untracked: [],
    ignoredCount: 0,
  };
}

/**
 * Read-only diagnostic merge-join between the sorted filesystem walk and
 * state.db's sorted entries -- structurally the same streaming comparison
 * update-cache.ts's performUpdateCache uses, but this never writes
 * anything: it exists purely to surface bugs (a corrupt/dangling stub, a
 * tampered file, an entry whose object vanished from S3, an untracked
 * file) that update_cache/materialize would otherwise silently repair or
 * never notice at all. See docs/architecture/ignore-and-storage-policies.md
 * for why ignore-policy matching happens in-memory rather than via SQL.
 *
 * `entriesRepo` and `objectsRepo`/`ignorePoliciesRepo` must come from
 * *separate* connections to state.db: `entriesRepo`'s iterator holds an
 * open cursor for the whole merge-join, and better-sqlite3 forbids any
 * other statement on that same connection while it's open.
 *
 * `filterGlob`, when given, scopes which tracked/untracked paths are
 * actually reported (and, for tracked paths, which ones incur the cost of
 * a rehash/HEAD check) -- the merge-join itself always walks the whole
 * tree and the whole entries table, since a partial merge-join can't tell
 * "filtered out" apart from "genuinely missing" on either side.
 */
export async function performSanityCheck(
  root: string,
  entriesRepo: EntriesRepository,
  objectsRepo: ObjectsRepository,
  ignorePoliciesRepo: IgnorePoliciesRepository,
  objectExists: ObjectExistsChecker,
  logger: Logger,
  filterGlob?: string,
): Promise<SanityCheckResult> {
  const result = emptyResult();
  const ignoreGlobs = ignorePoliciesRepo.listGlobs();
  const inScope = (p: string): boolean =>
    filterGlob === undefined || matchesAnyGlob(p, [filterGlob]).matched;

  const fsIter = walk(root);
  const entryIter = entriesRepo.iterateAllSortedByPath();

  let fsNext = await fsIter.next();
  let entryNext = entryIter.next();

  while (!fsNext.done || !entryNext.done) {
    const fsEntry = fsNext.done ? null : fsNext.value;
    const entry = entryNext.done ? null : entryNext.value;

    if (fsEntry !== null && (entry === null || fsEntry.path < entry.path)) {
      if (inScope(fsEntry.path)) {
        const ignoreMatch = matchesAnyGlob(fsEntry.path, ignoreGlobs);
        if (ignoreMatch.matched) {
          result.ignoredCount++;
        } else {
          result.untracked.push(fsEntry.path);
        }
      }
      fsNext = await fsIter.next();
    } else if (entry !== null && (fsEntry === null || entry.path < fsEntry.path)) {
      if (inScope(entry.path)) {
        result.missingLocally.push(entry.path);
        logger.debug({ path: entry.path }, "sanity_check: tracked but missing locally");
      }
      entryNext = entryIter.next();
    } else if (fsEntry !== null && entry !== null) {
      if (inScope(entry.path)) {
        await checkTrackedEntry(fsEntry, entry, root, objectsRepo, objectExists, logger, result);
      }
      fsNext = await fsIter.next();
      entryNext = entryIter.next();
    }
  }

  return result;
}

async function checkTrackedEntry(
  fsEntry: WalkEntry,
  entry: EntryRow,
  root: string,
  objectsRepo: ObjectsRepository,
  objectExists: ObjectExistsChecker,
  logger: Logger,
  result: SanityCheckResult,
): Promise<void> {
  if (entry.type === "dir") return; // directories carry no content -- existence is the only signal, already confirmed by reaching here

  if (fsEntry.representation === "both") {
    result.bothStubAndReal.push(entry.path);
    logger.debug({ path: entry.path }, "sanity_check: both a stub and the real file are present");
    return;
  }

  const absolutePath = path.join(root, entry.path);

  if (fsEntry.representation === "real") {
    const actualHash = await hashFile(absolutePath);
    if (entry.hash !== null && actualHash !== entry.hash) {
      result.hashMismatch.push({ path: entry.path, expectedHash: entry.hash, actualHash });
      return;
    }
  } else {
    let stubHash: string;
    try {
      stubHash = readStubHash(stubPathFor(absolutePath));
    } catch (err) {
      if (err instanceof StubFormatError) {
        result.stubMismatch.push({ path: entry.path, reason: err.message });
        return;
      }
      throw err;
    }
    if (entry.hash !== null && stubHash !== entry.hash) {
      result.stubMismatch.push({
        path: entry.path,
        reason: `stub declares hash ${stubHash}, state.db expects ${entry.hash}`,
      });
      return;
    }
  }

  if (!entry.hash) return; // a file entry should always have a hash; nothing further to verify if it somehow doesn't

  const objectRow = objectsRepo.get(entry.hash);
  if (!objectRow) {
    result.missingInS3.push({ path: entry.path, hash: entry.hash });
    return;
  }
  if (!(await objectExists(objectRow.s3_key))) {
    result.missingInS3.push({ path: entry.path, hash: entry.hash });
  }
}
