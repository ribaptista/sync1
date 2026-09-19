import fs from "node:fs";
import path from "node:path";
import type PQueue from "p-queue";
import type { Logger } from "../logger.js";
import { walk } from "./walker.js";
import { matchesAnyGlob, literalPrefixOf } from "./glob-match.js";
import { waitForRoom } from "../concurrency/pools.js";
import type { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import type { ThumbnailPolicyRow } from "../db/repositories/thumbnail-policies-repository.js";
import type { MediaProber, ProbedMedia } from "../media/probe.js";
import {
  computeContainFitSize,
  ThumbnailGenerationError,
  type ThumbnailGenerator,
} from "../media/thumbnail-generate.js";

export type ThumbnailRunMode = "state" | "ensure" | "cleanup";

/**
 * A stubbed original whose existing thumbnail's hash no longer matches the
 * stub's own current content hash -- the file was edited after the
 * thumbnail was generated, then stubified before a sync ever regenerated
 * it. Unregenerable without materializing the file first, so it's neither
 * silently kept (misleading -- it's not actually a preview of the current
 * content) nor silently deleted (destroying the only copy of a preview
 * that can never be recreated from the stub alone) -- see
 * `--delete-stale-stub-previews` on `thumbnail cleanup`.
 */
export interface StaleStubPreview {
  path: string;
  thumbnailPath: string;
}

export interface ThumbnailScanStats {
  upToDate: number;
  toGenerate: number;
  toRegenerate: number;
  toDelete: number;
  missingCacheEntry: number;
  stubbedOriginal: number;
  stubbedPreserved: number;
  staleStubPreviews: StaleStubPreview[];
  errors: number;
}

const THUMBNAIL_DIR_NAME = "_thumbnail";

interface ExistingThumbnailFile {
  /** relative to the vault root -- the thumbnail file's own path */
  relativePath: string;
  /** relative to the vault root -- the original this thumbnail is for */
  originalRelativePath: string;
  hash: string;
  thumbExt: string;
}

/**
 * Recognizes a walked entry as living directly inside a `_thumbnail/`
 * directory and reverse-parses its filename (`<original-name>.<hash>.
 * <thumb-ext>`) back into the original it belongs to. Returns `undefined`
 * both for anything not under a `_thumbnail/` dir at all, and for a
 * filename shape we don't recognize (fewer than the three required
 * dot-separated parts) -- never touched or tallied, matching this
 * project's general "never act on something we don't recognize the shape
 * of" discipline.
 */
function parseThumbnailEntry(relativePath: string): ExistingThumbnailFile | undefined {
  const dir = path.dirname(relativePath);
  if (path.basename(dir) !== THUMBNAIL_DIR_NAME) return undefined;

  const filename = path.basename(relativePath);
  const parts = filename.split(".");
  if (parts.length < 3) return undefined;

  const thumbExt = parts[parts.length - 1]!;
  const hash = parts[parts.length - 2]!;
  const originalName = parts.slice(0, -2).join(".");
  if (originalName.length === 0) return undefined;

  const originalDir = path.dirname(dir);
  const originalRelativePath =
    originalDir === "." ? originalName : `${originalDir}/${originalName}`;

  return { relativePath, originalRelativePath, hash, thumbExt };
}

function fileExtension(relativePath: string): string {
  const base = path.basename(relativePath);
  const dotIndex = base.lastIndexOf(".");
  return dotIndex === -1 ? "" : base.slice(dotIndex + 1);
}

function thumbnailRelativePath(
  originalRelativePath: string,
  hash: string,
  thumbExt: string,
): string {
  const dir = path.dirname(originalRelativePath);
  const base = path.basename(originalRelativePath);
  const thumbDir = dir === "." ? THUMBNAIL_DIR_NAME : `${dir}/${THUMBNAIL_DIR_NAME}`;
  return `${thumbDir}/${base}.${hash}.${thumbExt}`;
}

function mimeTypeMatches(pattern: string, mimeType: string): boolean {
  if (pattern === mimeType) return true;
  const [patternType, patternSubtype] = pattern.split("/");
  const [actualType] = mimeType.split("/");
  return patternSubtype === "*" && patternType === actualType;
}

function policyMatches(
  policy: ThumbnailPolicyRow,
  relativePath: string,
  mimeType: string,
): boolean {
  if (!matchesAnyGlob(relativePath, [policy.glob]).matched) {
    return false;
  }
  return policy.mimeTypes.some((pattern) => mimeTypeMatches(pattern, mimeType));
}

/** Cheap, in-memory, zero-I/O pre-filter: only a path whose glob already matches *some* policy is ever worth probing at all. */
function anyGlobMatches(relativePath: string, policies: readonly ThumbnailPolicyRow[]): boolean {
  return policies.some((p) => matchesAnyGlob(relativePath, [p.glob]).matched);
}

type PolicyResolution = { action: "skip" } | { action: "generate"; policy: ThumbnailPolicyRow };

/** Any matching 'skip' wins outright (monotonic OR, like ignore_policies); otherwise the lowest-priority matching 'generate' row wins. `undefined` = not a candidate at all. */
function resolvePolicy(
  relativePath: string,
  mimeType: string,
  policies: readonly ThumbnailPolicyRow[],
): PolicyResolution | undefined {
  const skipMatch = policies.some(
    (p) => p.action === "skip" && policyMatches(p, relativePath, mimeType),
  );
  if (skipMatch) return { action: "skip" };

  const generateMatches = policies
    .filter((p) => p.action === "generate" && policyMatches(p, relativePath, mimeType))
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const best = generateMatches[0];
  return best ? { action: "generate", policy: best } : undefined;
}

/**
 * A "real" (or "both", real-with-dangling-stub) candidate: fully probed,
 * carries a resolved policy. A "stub" candidate never touches a prober or
 * policy resolution at all -- see `classifyStub` below for why that's
 * correct, not merely a shortcut.
 */
interface ProvisionalDecisionProbed {
  kind: "probed";
  relativePath: string;
  cacheHash: string | null;
  probed: ProbedMedia;
  resolution: { action: "skip" } | { action: "generate"; policy: ThumbnailPolicyRow };
}

interface ProvisionalDecisionStub {
  kind: "stub";
  relativePath: string;
  cacheHash: string | null;
}

type ProvisionalDecision = ProvisionalDecisionProbed | ProvisionalDecisionStub;

function expectedThumbExtension(decision: ProvisionalDecisionProbed): string {
  return decision.probed.kind === "video" ? "jpg" : fileExtension(decision.relativePath);
}

async function classifyProbed(
  relativePath: string,
  root: string,
  cacheRepo: CacheEntriesRepository,
  policies: readonly ThumbnailPolicyRow[],
  prober: MediaProber,
): Promise<ProvisionalDecisionProbed | undefined> {
  const probed = await prober.detectMedia(path.join(root, relativePath));
  if (!probed) return undefined;

  const resolution = resolvePolicy(relativePath, probed.mimeType, policies);
  if (!resolution) return undefined;

  const cacheRow = cacheRepo.get(relativePath);
  return {
    kind: "probed",
    relativePath,
    cacheHash: cacheRow?.hash ?? null,
    probed,
    resolution,
  };
}

/**
 * A stub has no real bytes on disk to probe, so mime type -- hence policy
 * resolution, hence the expected thumbnail extension -- can't be recovered
 * for it. That's fine: none of that is needed for *preserving* an existing
 * thumbnail, only for *generating* one, which never happens for a stub
 * (see `scanThumbnails`'s reconciliation loop). All preservation needs is
 * the stub's own self-declared content hash, already sitting in cache.db --
 * `update-cache.ts` populates a stub's cache row straight from
 * `readStubHash`, exactly as reliable as a real file's hash would be.
 */
function classifyStub(
  relativePath: string,
  cacheRepo: CacheEntriesRepository,
): ProvisionalDecisionStub {
  const cacheRow = cacheRepo.get(relativePath);
  return { kind: "stub", relativePath, cacheHash: cacheRow?.hash ?? null };
}

function deleteThumbnailFile(root: string, thumb: ExistingThumbnailFile): void {
  const absolutePath = path.join(root, thumb.relativePath);
  if (fs.existsSync(absolutePath)) fs.rmSync(absolutePath);
}

/**
 * Generates (or regenerates, deleting `staleThumbnail` first) one
 * thumbnail. Per-file failures become `ThumbnailGenerationError`, caught
 * by the caller.
 *
 * `policy` is still typed as the full `ThumbnailPolicyRow` union here (a
 * later task narrows `resolvePolicy`'s "generate" branch to
 * `ThumbnailPolicyGenerateRow` at the source, which would make the
 * `action`/`mediaType` checks below statically redundant) -- until then,
 * both checks are real, cheap runtime narrowing rather than a `!` lie:
 * `scanThumbnails` only ever reaches this function for a "generate"
 * resolution whose `mediaType` agrees with `decision.probed.kind` (per
 * `validateMediaTypeMimeConsistency`), so neither throw should ever fire
 * in practice.
 */
async function generateForDecision(
  root: string,
  decision: ProvisionalDecisionProbed,
  policy: ThumbnailPolicyRow,
  staleThumbnail: ExistingThumbnailFile | undefined,
  generator: ThumbnailGenerator,
  logger: Logger,
): Promise<void> {
  if (policy.action !== "generate") {
    throw new Error(`internal error: generateForDecision called with a '${policy.action}' policy`);
  }

  if (staleThumbnail) deleteThumbnailFile(root, staleThumbnail);

  const thumbExt = expectedThumbExtension(decision);
  const destRelativePath = thumbnailRelativePath(
    decision.relativePath,
    decision.cacheHash!,
    thumbExt,
  );
  const destAbsolutePath = path.join(root, destRelativePath);
  fs.mkdirSync(path.dirname(destAbsolutePath), { recursive: true });
  const sourceAbsolutePath = path.join(root, decision.relativePath);

  if (decision.probed.kind === "image") {
    if (policy.mediaType !== "image") {
      throw new Error(
        `internal error: matched policy media type "${policy.mediaType}" doesn't agree with probed kind "image" for "${decision.relativePath}"`,
      );
    }
    const size = computeContainFitSize(
      { width: decision.probed.width, height: decision.probed.height },
      { width: policy.imageWidth, height: policy.imageHeight },
    );
    await generator.generateImageThumbnail(
      {
        sourcePath: sourceAbsolutePath,
        destPath: destAbsolutePath,
        width: size.width,
        height: size.height,
        jpegQuality: policy.jpegQuality,
      },
      logger,
    );
  } else {
    if (policy.mediaType !== "video") {
      throw new Error(
        `internal error: matched policy media type "${policy.mediaType}" doesn't agree with probed kind "video" for "${decision.relativePath}"`,
      );
    }
    await generator.generateVideoMosaic(
      {
        sourcePath: sourceAbsolutePath,
        destPath: destAbsolutePath,
        sourceWidth: decision.probed.width,
        sourceHeight: decision.probed.height,
        durationSeconds: decision.probed.durationSeconds,
        tileRowCount: policy.tileRowCount,
        tileColumnCount: policy.tileColumnCount,
        tileSize: policy.tileSize,
        jpegQuality: policy.jpegQuality,
      },
      logger,
    );
  }
}

/**
 * Single filesystem walk shared by `state`/`ensure`/`cleanup` (never three
 * separate ones): classifies every candidate original -- against
 * `thumbnail_policies` for a real (or "both") entry, dispatched to `pool`
 * and mime-probed only once its path already matches some policy's glob;
 * or, for a stub, synchronously via a pure cache.db-hash lookup, no
 * probing or policy resolution at all (a stub has no real bytes to probe,
 * and none of that is needed for the only thing a stub decision can ever
 * do here: preserve, flag-stale, or leave-as-orphan an *existing*
 * thumbnail -- see `classifyStub`) -- while separately collecting every
 * existing `_thumbnail/` file it encounters along the way. Once the walk
 * (and its dispatched classification jobs) fully settles, every
 * provisional decision is reconciled against the collected existing-
 * thumbnail map, and whatever's left unclaimed in that map (an original
 * deleted/renamed, or simply outside this run's own `--glob`) becomes an
 * orphan, also counted under `toDelete`.
 *
 * `state` only tallies; `ensure` dispatches actual generation for
 * to-generate/to-regenerate entries back through the same `pool` (deleting
 * the stale file first when regenerating, within that same job) -- never
 * for a stub, which is never a generation candidate; `cleanup`
 * synchronously deletes every `toDelete` file, and additionally a stale
 * stub preview's thumbnail when `deleteStaleStubPreviews` is set. A
 * per-file `ThumbnailGenerationError` is caught, tallied under `errors`,
 * and never aborts the run; anything else (in particular
 * `MediaToolMissingError`) propagates and aborts, since categorically
 * nothing can be thumbnailed at all without the tool.
 */
export async function scanThumbnails(
  root: string,
  mode: ThumbnailRunMode,
  glob: string | undefined,
  cacheRepo: CacheEntriesRepository,
  policies: readonly ThumbnailPolicyRow[],
  prober: MediaProber,
  generator: ThumbnailGenerator,
  logger: Logger,
  pool: PQueue,
  poolQueueLimit: number,
  /**
   * Only meaningful for `cleanup`; `state`/`ensure`'s call sites always
   * pass `false` explicitly (neither mode deletes anything at all) rather
   * than relying on `mode === "cleanup"` alone to also imply this --
   * deleting the only copy of an unregenerable preview is a materially
   * bigger decision than the other `cleanup` buckets, so it gets its own
   * explicit opt-in at every call site.
   */
  deleteStaleStubPreviews: boolean,
  onProgress?: (scanned: number) => void,
): Promise<ThumbnailScanStats> {
  const stats: ThumbnailScanStats = {
    upToDate: 0,
    toGenerate: 0,
    toRegenerate: 0,
    toDelete: 0,
    missingCacheEntry: 0,
    stubbedOriginal: 0,
    stubbedPreserved: 0,
    staleStubPreviews: [],
    errors: 0,
  };

  const literalPrefix = glob ? literalPrefixOf(glob) : "";
  const walkRoot = literalPrefix ? path.join(root, literalPrefix) : root;
  if (!fs.existsSync(walkRoot)) return stats; // --glob's literal prefix doesn't exist -- nothing to do, not an error

  const existingThumbnails = new Map<string, ExistingThumbnailFile[]>();
  const decisions: ProvisionalDecision[] = [];

  let scanned = 0;
  for await (const fsEntry of walk(walkRoot)) {
    scanned++;
    onProgress?.(scanned);
    if (fsEntry.type === "dir") continue;

    const relativePath = literalPrefix ? `${literalPrefix}/${fsEntry.path}` : fsEntry.path;

    const thumbnailEntry = parseThumbnailEntry(relativePath);
    if (thumbnailEntry) {
      const list = existingThumbnails.get(thumbnailEntry.originalRelativePath) ?? [];
      list.push(thumbnailEntry);
      existingThumbnails.set(thumbnailEntry.originalRelativePath, list);
      continue;
    }

    if (glob && !matchesAnyGlob(relativePath, [glob]).matched) continue;
    if (!anyGlobMatches(relativePath, policies)) continue;

    if (fsEntry.representation === "stub") {
      // Synchronous, no subprocess -- no pool dispatch needed.
      decisions.push(classifyStub(relativePath, cacheRepo));
      continue;
    }

    await waitForRoom(pool, poolQueueLimit);
    void pool.add(async () => {
      const decision = await classifyProbed(relativePath, root, cacheRepo, policies, prober);
      if (decision) decisions.push(decision);
      logger.debug({ pool: "thumbnail", inFlight: pool.pending, queued: pool.size }, "completed");
    });
    logger.debug({ pool: "thumbnail", inFlight: pool.pending, queued: pool.size }, "dispatched");
  }

  await pool.onIdle();

  const claimedOriginals = new Set<string>();

  for (const decision of decisions) {
    claimedOriginals.add(decision.relativePath);
    const existing = existingThumbnails.get(decision.relativePath) ?? [];

    if (decision.kind === "stub") {
      if (decision.cacheHash === null) {
        stats.missingCacheEntry++;
        continue;
      }

      const match = existing.find((t) => t.hash === decision.cacheHash);
      if (match) {
        // Preserved -- any *other* existing entries are genuine leftover
        // duplicates (e.g. from an earlier config change), cleaned up the
        // same as any other extra, not reported as stale.
        stats.stubbedPreserved++;
        for (const thumb of existing) {
          if (thumb === match) continue;
          stats.toDelete++;
          if (mode === "cleanup") deleteThumbnailFile(root, thumb);
        }
      } else if (existing.length > 0) {
        // Stale, not orphaned: the stub's current content hash doesn't
        // match any existing thumbnail, so none can be trusted as a
        // preview of the file's actual current content -- but none can be
        // regenerated either, without materializing the file first.
        for (const thumb of existing) {
          stats.staleStubPreviews.push({
            path: decision.relativePath,
            thumbnailPath: thumb.relativePath,
          });
          if (mode === "cleanup" && deleteStaleStubPreviews) deleteThumbnailFile(root, thumb);
        }
      } else {
        stats.stubbedOriginal++;
      }
      continue;
    }

    if (decision.resolution.action === "skip") {
      for (const thumb of existing) {
        stats.toDelete++;
        if (mode === "cleanup") deleteThumbnailFile(root, thumb);
      }
      continue;
    }

    if (decision.cacheHash === null) {
      stats.missingCacheEntry++;
      continue;
    }

    const expectedExt = expectedThumbExtension(decision);
    const upToDateMatch = existing.find(
      (t) => t.hash === decision.cacheHash && t.thumbExt === expectedExt,
    );

    if (upToDateMatch) {
      stats.upToDate++;
      for (const thumb of existing) {
        if (thumb === upToDateMatch) continue;
        stats.toDelete++;
        if (mode === "cleanup") deleteThumbnailFile(root, thumb);
      }
      continue;
    }

    const policy = decision.resolution.policy;
    if (existing.length > 0) {
      stats.toRegenerate++;
      if (mode === "ensure") {
        const staleThumbnail = existing[0];
        await waitForRoom(pool, poolQueueLimit);
        void pool.add(async () => {
          try {
            await generateForDecision(root, decision, policy, staleThumbnail, generator, logger);
          } catch (err) {
            if (!(err instanceof ThumbnailGenerationError)) throw err;
            stats.errors++;
            logger.warn(
              { path: decision.relativePath, err: err.message },
              "thumbnail regeneration failed -- skipping",
            );
          }
        });
      }
    } else {
      stats.toGenerate++;
      if (mode === "ensure") {
        await waitForRoom(pool, poolQueueLimit);
        void pool.add(async () => {
          try {
            await generateForDecision(root, decision, policy, undefined, generator, logger);
          } catch (err) {
            if (!(err instanceof ThumbnailGenerationError)) throw err;
            stats.errors++;
            logger.warn(
              { path: decision.relativePath, err: err.message },
              "thumbnail generation failed -- skipping",
            );
          }
        });
      }
    }
  }

  if (mode === "ensure") await pool.onIdle();

  for (const [originalPath, thumbs] of existingThumbnails) {
    if (claimedOriginals.has(originalPath)) continue;
    for (const thumb of thumbs) {
      stats.toDelete++;
      if (mode === "cleanup") deleteThumbnailFile(root, thumb);
    }
  }

  return stats;
}
