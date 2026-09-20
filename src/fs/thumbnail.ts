import fs from "node:fs";
import path from "node:path";
import type PQueue from "p-queue";
import type { Logger } from "../logger.js";
import { walk } from "./walker.js";
import { matchesAnyGlob, literalPrefixOf } from "./glob-match.js";
import { waitForRoom } from "../concurrency/pools.js";
import { enumerateThumbnailScan } from "./thumbnail-enumerate.js";
import type { EnumerationControl } from "./update-cache-enumerate.js";
import type { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import type {
  ThumbnailPolicyRow,
  ThumbnailPolicyGenerateRow,
} from "../db/repositories/thumbnail-policies-repository.js";
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

/** Exported for `stubify.ts`: the thumbnail dir's name is hardcoded, so `stubify` can exclude it automatically -- see `isUnderThumbnailDir`. */
export const THUMBNAIL_DIR_NAME = "_thumbnail";

/** True for any path with a `_thumbnail` path segment anywhere in it, not just a direct child -- e.g. both `_thumbnail/photo.jpg...jpg` and `sub/_thumbnail/photo.jpg...jpg`. */
export function isUnderThumbnailDir(relativePath: string): boolean {
  return relativePath.split("/").includes(THUMBNAIL_DIR_NAME);
}

/**
 * Encodes a policy's *identity* (its name -- now that more than one
 * 'generate' policy can match the same original, the params segment must
 * tell their outputs apart) and raw *configured* generation parameters
 * (never a per-file computed/derived size) into a filename segment, so a
 * policy config change naturally produces a different expected filename
 * even when the original's own content hash hasn't changed -- the
 * existing orphan-reconciliation logic already handles that case for free
 * (a mismatched expected filename means "not up to date"), no separate
 * regeneration-detection mechanism needed. A side effect, deliberate: a
 * policy *rename* is therefore indistinguishable from deleting the old
 * policy and creating a new one under a new name -- reconciliation
 * produces exactly one deletion and one regeneration, which is the
 * correct reaction to a rename it has no other way to detect.
 *
 * Literal abbreviated fields rather than a hash of them: worst case
 * (`p1-somepolicyname-tr9999-tc9999-ts65535-q100`) still leaves plenty of
 * the 255-byte path-component limit spare even after the hash and
 * extension, so length was never the binding constraint -- a human being
 * able to `ls _thumbnail/` and read off what config produced a file, with
 * no database cross-reference, is worth far more than the bytes a hash
 * would reclaim. `PARAMS_VERSION` exists so a future incompatible change
 * to this segment's own shape can be told apart from today's, rather than
 * silently misparsed.
 */
const PARAMS_VERSION = "p1";
/**
 * Deliberately loose about the name segment specifically: parsing an
 * existing filename never extracts individual fields out of this segment
 * (see `parseThumbnailEntry` below) -- it's only ever compared for whole-
 * string equality against a freshly recomputed `expectedParamsSegment`,
 * so there's no ambiguity to resolve between "the name" and "a field"
 * even though both share the same charset. This regex exists purely to
 * reject a filename that doesn't look like *any* recognized shape (fewer
 * than one name plus one field pair) so it's left alone rather than
 * mis-tracked -- see the fuller discussion at `parseThumbnailEntry`.
 */
const PARAMS_SEGMENT_RE = /^p1-[A-Za-z0-9_]+(?:-[a-z]+\d+)+$/;

function expectedParamsSegment(policy: ThumbnailPolicyGenerateRow): string {
  return policy.mediaType === "image"
    ? `${PARAMS_VERSION}-${policy.name}-iw${policy.imageWidth}-ih${policy.imageHeight}-q${policy.jpegQuality}`
    : `${PARAMS_VERSION}-${policy.name}-tr${policy.tileRowCount}-tc${policy.tileColumnCount}-ts${policy.tileSize}-q${policy.jpegQuality}`;
}

interface ExistingThumbnailFile {
  /** relative to the vault root -- the thumbnail file's own path */
  relativePath: string;
  /** relative to the vault root -- the original this thumbnail is for */
  originalRelativePath: string;
  paramsSegment: string;
  /**
   * The params segment's own second token -- structurally always the
   * policy name that produced it (see `expectedParamsSegment`), extracted
   * once at parse time so reconciliation can ask "is this *this policy's*
   * previous output" (by name, surviving a field change like a resized
   * image box) without re-deriving it from the full segment string each
   * time. `paramsSegment` itself stays the *whole-string* identity used
   * for the separate, stricter "is this up to date" check.
   */
  policyName: string;
  hash: string;
  thumbExt: string;
}

/**
 * Recognizes a walked entry as living directly inside a `_thumbnail/`
 * directory and reverse-parses its filename (`<original-name>.
 * <params-segment>.<hash>.<thumb-ext>`) back into the original it belongs
 * to. Returns `undefined` both for anything not under a `_thumbnail/` dir
 * at all, and for a filename shape we don't recognize -- fewer than the
 * four required dot-separated parts, or a third-from-last part that
 * doesn't match `PARAMS_SEGMENT_RE` -- never touched or tallied, matching
 * this project's general "never act on something we don't recognize the
 * shape of" discipline. The `PARAMS_SEGMENT_RE` check specifically is what
 * keeps this from *mis*-parsing a pre-this-change filename (three
 * dot-parts, e.g. `sunset.jpg.<hash>.jpg`) as if its "params" slot were
 * the literal token `jpg` -- that filename now correctly falls through as
 * unrecognized instead.
 */
function parseThumbnailEntry(relativePath: string): ExistingThumbnailFile | undefined {
  const dir = path.dirname(relativePath);
  if (path.basename(dir) !== THUMBNAIL_DIR_NAME) return undefined;

  const filename = path.basename(relativePath);
  const parts = filename.split(".");
  if (parts.length < 4) return undefined;

  const thumbExt = parts[parts.length - 1]!;
  const hash = parts[parts.length - 2]!;
  const paramsSegment = parts[parts.length - 3]!;
  if (!PARAMS_SEGMENT_RE.test(paramsSegment)) return undefined;
  // Position, not content, is what's guaranteed here: PARAMS_SEGMENT_RE
  // has already confirmed the shape is "p1-<name>-<field><num>...", so
  // the second dash-separated token is always the policy name, whatever
  // it happens to look like.
  const policyName = paramsSegment.split("-")[1]!;
  const originalName = parts.slice(0, -3).join(".");
  if (originalName.length === 0) return undefined;

  const originalDir = path.dirname(dir);
  const originalRelativePath =
    originalDir === "." ? originalName : `${originalDir}/${originalName}`;

  return { relativePath, originalRelativePath, paramsSegment, policyName, hash, thumbExt };
}

function fileExtension(relativePath: string): string {
  const base = path.basename(relativePath);
  const dotIndex = base.lastIndexOf(".");
  return dotIndex === -1 ? "" : base.slice(dotIndex + 1);
}

function thumbnailRelativePath(
  originalRelativePath: string,
  paramsSegment: string,
  hash: string,
  thumbExt: string,
): string {
  const dir = path.dirname(originalRelativePath);
  const base = path.basename(originalRelativePath);
  const thumbDir = dir === "." ? THUMBNAIL_DIR_NAME : `${dir}/${THUMBNAIL_DIR_NAME}`;
  return `${thumbDir}/${base}.${paramsSegment}.${hash}.${thumbExt}`;
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

type PolicyResolution =
  { action: "skip" } | { action: "generate"; policies: ThumbnailPolicyGenerateRow[] };

/**
 * Any matching 'skip' wins outright (monotonic OR, like ignore_policies)
 * and suppresses every 'generate' match, same as before -- there's still
 * no priority among 'skip' rows, since they all agree with each other by
 * construction. Unlike before, there's no winner among 'generate' matches
 * either: *every* matching 'generate' row produces its own thumbnail, one
 * per policy (see `expectedParamsSegment`, which is what keeps their
 * outputs from colliding). `undefined` = not a candidate at all (no
 * match, skip or generate).
 */
function resolvePolicies(
  relativePath: string,
  mimeType: string,
  policies: readonly ThumbnailPolicyRow[],
): PolicyResolution | undefined {
  const skipMatch = policies.some(
    (p) => p.action === "skip" && policyMatches(p, relativePath, mimeType),
  );
  if (skipMatch) return { action: "skip" };

  const generateMatches = policies.filter(
    (p): p is ThumbnailPolicyGenerateRow =>
      p.action === "generate" && policyMatches(p, relativePath, mimeType),
  );
  return generateMatches.length > 0 ? { action: "generate", policies: generateMatches } : undefined;
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
  resolution: PolicyResolution;
}

interface ProvisionalDecisionStub {
  kind: "stub";
  relativePath: string;
  cacheHash: string | null;
}

type ProvisionalDecision = ProvisionalDecisionProbed | ProvisionalDecisionStub;

/**
 * One thumbnail `ensure` has decided to generate, held until every
 * decision has been made. Reconciliation used to dispatch these as it
 * went, which meant the generation total could only be discovered as
 * quickly as the pool drained -- and the pool is exactly what the bar is
 * there to report on. `staleThumbnail` set means this is a regeneration:
 * the old file is deleted inside the job, and it's also what picks the
 * right word for a failure's log line.
 */
interface GenerationJob {
  decision: ProvisionalDecisionProbed;
  policy: ThumbnailPolicyGenerateRow;
  staleThumbnail: ExistingThumbnailFile | undefined;
}

/**
 * Image mime types ImageMagick can read but not write (`identify -list
 * format` shows each as `r--`) -- a thumbnail generated from one can
 * never keep the original's own extension the way an ordinary image does,
 * since asking `convert` to *write* that format would fail outright with
 * no encoder available. Forced to `.jpg` instead, the same way a video
 * mosaic always is regardless of its own container.
 */
const RAW_IMAGE_MIME_TYPES = new Set<string>(["image/x-canon-cr2"]);

function expectedThumbExtension(decision: ProvisionalDecisionProbed): string {
  if (decision.probed.kind === "video") return "jpg";
  if (RAW_IMAGE_MIME_TYPES.has(decision.probed.mimeType)) return "jpg";
  return fileExtension(decision.relativePath);
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

  const resolution = resolvePolicies(relativePath, probed.mimeType, policies);
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
 * `policy` is `ThumbnailPolicyGenerateRow` -- `resolvePolicies`'s
 * "generate" branch is narrowed at the source, so there's no 'skip'
 * branch left to guard against here. The `mediaType` checks below are
 * still real, necessary runtime narrowing, not dead code: `ThumbnailPolicyGenerateRow`
 * is itself still a union of an "image" branch and a "video" branch, and
 * nothing in the type system connects that to `decision.probed.kind` --
 * `scanThumbnails` only ever reaches this function for a resolution whose
 * `mediaType` agrees with what was actually probed (guaranteed at the
 * data level by `validateMediaTypeMimeConsistency`, not provable from
 * types alone), so these throws are defense-in-depth against a state.db
 * reached by some future path that bypasses the repository, not expected
 * to ever fire in practice.
 */
async function generateForDecision(
  root: string,
  decision: ProvisionalDecisionProbed,
  policy: ThumbnailPolicyGenerateRow,
  staleThumbnail: ExistingThumbnailFile | undefined,
  generator: ThumbnailGenerator,
  logger: Logger,
): Promise<void> {
  if (staleThumbnail) deleteThumbnailFile(root, staleThumbnail);

  const thumbExt = expectedThumbExtension(decision);
  const paramsSegment = expectedParamsSegment(policy);
  const destRelativePath = thumbnailRelativePath(
    decision.relativePath,
    paramsSegment,
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
 *
 * `onProgress` covers the filesystem-walk phase only (every mode).
 * `onGenerationProgress` covers `ensure`'s own generation phase
 * separately -- deliberately not folded into `onProgress`'s own
 * cumulative count, since "files scanned" and "thumbnails generated" are
 * different units caller-side progress reporting needs to track
 * independently (see `runThumbnailMode` in `src/commands/thumbnail.ts`).
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
  /**
   * `ensure`-only: fires once as the generation phase opens, then once per
   * completed generation attempt (success or failure, from a `finally`).
   * `total` is the *exact, final* number of thumbnails this run will
   * generate -- every candidate is already known by the time the first one
   * is dispatched, so it is correct from the very first call and never
   * revised; `generated` is the running count so far, not a delta. Never
   * fires at all for `state`/`cleanup`, since neither mode ever generates
   * anything.
   */
  onGenerationProgress?: (total: number, generated: number) => void,
  /**
   * Fires with the walk phase's running entry total, then once more with
   * the real walk's own final count (`final: true`) once the walk has
   * settled. Pairs with `onProgress`'s numerator -- same unit, every
   * walked entry -- so the two together make a real ratio rather than a
   * count standing in for its own total. See thumbnail-enumerate.ts.
   */
  onScanTotalKnown?: (total: number, final: boolean) => void,
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

  // Started, deliberately not awaited: it counts the same entries this
  // walk is about to visit, concurrently, so the denominator is known
  // within a walk rather than only once the last probe lands.
  const enumerationControl: EnumerationControl = { stop: false };
  const enumeration = enumerateThumbnailScan(
    walkRoot,
    onScanTotalKnown,
    logger,
    enumerationControl,
  );

  let scanned = 0;
  try {
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
  } finally {
    // The walk is done (or has thrown), so whatever the counting pass has
    // left to count is now worthless -- cut it short, join it so it can't
    // publish after the fact, then publish the real walk's own count as
    // the final word.
    enumerationControl.stop = true;
    await enumeration;
    onScanTotalKnown?.(scanned, true);
  }

  const claimedOriginals = new Set<string>();
  // Collected here, dispatched below: every generation candidate is known
  // by the time this reconciliation loop ends, so collecting them first
  // costs nothing and lets the generation phase open with its exact,
  // final denominator instead of one that grows as jobs are dispatched --
  // which, throttled by waitForRoom, is exactly as slowly as they finish.
  const generationJobs: GenerationJob[] = [];

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

    // An original can now match more than one 'generate' policy at once,
    // each producing its own thumbnail -- so each policy is reconciled
    // against `existing` independently, keyed by its own params segment
    // (which embeds the policy's name, so two policies' outputs for the
    // same original never collide). `claimedThumbs` tracks which existing
    // files any policy accounted for; whatever's left over at the end --
    // an orphan from a deleted/renamed policy, or a leftover duplicate --
    // is swept the same way a single-policy setup always has been.
    const expectedExt = expectedThumbExtension(decision);
    const claimedThumbs = new Set<ExistingThumbnailFile>();

    for (const policy of decision.resolution.policies) {
      const expectedParams = expectedParamsSegment(policy);
      const upToDateMatch = existing.find(
        (t) =>
          t.hash === decision.cacheHash &&
          t.thumbExt === expectedExt &&
          t.paramsSegment === expectedParams,
      );

      if (upToDateMatch) {
        stats.upToDate++;
        claimedThumbs.add(upToDateMatch);
        continue;
      }

      // Not up to date for *this* policy specifically -- an existing file
      // whose params segment names this same policy (by name, regardless
      // of whether its *other* fields -- a resized box, say -- have since
      // changed) is this policy's own previous output, safe to delete-
      // and-regenerate; absent that, this policy has never produced
      // anything for this original before, so it's a fresh generation,
      // not a regeneration. Matching by name rather than the whole
      // segment is what lets an ordinary config edit (not a rename) still
      // read as "regenerate", exactly as it always has.
      const staleForThisPolicy = existing.find((t) => t.policyName === policy.name);
      if (staleForThisPolicy) {
        stats.toRegenerate++;
        claimedThumbs.add(staleForThisPolicy);
        if (mode === "ensure") {
          generationJobs.push({ decision, policy, staleThumbnail: staleForThisPolicy });
        }
      } else {
        stats.toGenerate++;
        if (mode === "ensure") {
          generationJobs.push({ decision, policy, staleThumbnail: undefined });
        }
      }
    }

    for (const thumb of existing) {
      if (claimedThumbs.has(thumb)) continue;
      stats.toDelete++;
      if (mode === "cleanup") deleteThumbnailFile(root, thumb);
    }
  }

  if (mode === "ensure") {
    let completedGeneration = 0;
    // Published before the first dispatch, and never revised: this is the
    // whole generation phase's denominator, not a running discovery count.
    onGenerationProgress?.(generationJobs.length, completedGeneration);
    for (const job of generationJobs) {
      await waitForRoom(pool, poolQueueLimit);
      void pool.add(async () => {
        try {
          await generateForDecision(
            root,
            job.decision,
            job.policy,
            job.staleThumbnail,
            generator,
            logger,
          );
        } catch (err) {
          if (!(err instanceof ThumbnailGenerationError)) throw err;
          stats.errors++;
          logger.warn(
            { path: job.decision.relativePath, err: err.message },
            job.staleThumbnail
              ? "thumbnail regeneration failed -- skipping"
              : "thumbnail generation failed -- skipping",
          );
        } finally {
          completedGeneration++;
          onGenerationProgress?.(generationJobs.length, completedGeneration);
        }
      });
    }
    await pool.onIdle();
  }

  for (const [originalPath, thumbs] of existingThumbnails) {
    if (claimedOriginals.has(originalPath)) continue;
    for (const thumb of thumbs) {
      stats.toDelete++;
      if (mode === "cleanup") deleteThumbnailFile(root, thumb);
    }
  }

  return stats;
}
