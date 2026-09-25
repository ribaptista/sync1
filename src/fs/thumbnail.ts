import fs from "node:fs";
import path from "node:path";
import type PQueue from "p-queue";
import type { Logger } from "../logger.js";
import { walk } from "./walker.js";
import { inTreeTempPathPreservingExtension } from "./temp-path.js";
import { matchesAnyGlob, literalPrefixOf } from "./glob-match.js";
import {
  waitForRoom,
  createPoolErrorBox,
  dispatchTracked,
  throwIfPoolErrored,
} from "../concurrency/pools.js";
import type { EnumerationControl } from "./update-cache-enumerate.js";
import type { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import type {
  ThumbnailPolicyRow,
  ThumbnailPolicyGenerateRow,
  ThumbnailOutputMime,
} from "../db/repositories/thumbnail-policies-repository.js";
import type { MediaProber, ProbedMedia } from "../media/probe.js";
import {
  computeContainFitSize,
  computeShorterSideFitSize,
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
  /**
   * The source path behind every `errors` tally, with the reason. Bounded
   * by the error count, not by tree size. Without it a per-file failure is
   * only a number, and the per-file warning that would have explained it
   * is invisible unless the caller happened to redirect fd 3 (see
   * src/cli/progress.ts, which diverts logging there while a bar owns
   * stderr).
   */
  failures: ThumbnailFailure[];
}

export interface ThumbnailFailure {
  path: string;
  reason: string;
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
 * Literal abbreviated fields rather than a hash of them: worst case still
 * leaves plenty of the 255-byte path-component limit spare even after the
 * hash and extension, so length was never the binding constraint -- a
 * human being able to `ls _thumbnail/` and read off what config produced a
 * file, with no database cross-reference, is worth far more than the bytes
 * a hash would reclaim. `PARAMS_VERSION` exists so a future incompatible
 * change to this segment's own shape can be told apart from today's,
 * rather than silently misparsed.
 */
const PARAMS_VERSION = "p2";
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
 *
 * Accepts both `p1-` and `p2-`: if this only matched `p2`, every existing
 * `p1` thumbnail on a real vault would become permanently unrecognized --
 * never claimed, but also never swept -- and would sit beside its `p2`
 * replacement forever. Keeping `p1` recognized means each old file is
 * still found by the policy-name lookup (`split("-")[1]` works identically
 * on either version's segment), counted `toRegenerate`, and deleted as its
 * `p2` replacement is written -- zero manual cleanup. Field values widen
 * from `p1`'s digits-only (`\d+`) to `[0-9A-Za-z_]+` for `p2`, since the
 * output-mime and dither tokens are no longer purely numeric -- see
 * `normalizeParamsValue`.
 */
const PARAMS_SEGMENT_RE = /^p[12]-[A-Za-z0-9_]+(?:-[a-z]+[0-9A-Za-z_]+)+$/;

/**
 * Any character outside `[0-9A-Za-z_]` becomes `_`, so a serialized value
 * can never contain the `-` field separator (nor a `.`, which would break
 * the outer filename split). No escaping and no tokenizer needed --
 * `split("-")` stays correct, and the segment stays readable. Lossy in
 * general, which is only safe because of what's actually serialized
 * through it: policy names (already restricted to this exact charset by
 * `NAME_PATTERN`, so this is a no-op for them) and the closed `outputMime`/
 * `gifDither` enums, whose members stay distinct after normalization.
 */
function normalizeParamsValue(v: string): string {
  return v.replace(/[^0-9A-Za-z_]/g, "_");
}

/**
 * One token per SIZING field, then `fmt<outputMime>`, then one token per
 * ENCODING field -- mirrors the repository's own two-axis split (see
 * `SIZING_FIELDS`/`ENCODING_FIELDS` in thumbnail-policies-repository.ts).
 * `shorterSide` (`ss`) is shared by every branch but `fit_to_box`, exactly
 * as the repository's own field carries across those branches.
 */
function expectedParamsSegment(policy: ThumbnailPolicyGenerateRow): string {
  const sizingTokens: string[] =
    policy.mediaType === "image"
      ? policy.resizingStrategy === "fit_to_box"
        ? [`iw${policy.imageWidth}`, `ih${policy.imageHeight}`]
        : [`ss${policy.shorterSide}`]
      : policy.outputType === "mosaic"
        ? [`ss${policy.shorterSide}`, `tr${policy.tileRowCount}`, `tc${policy.tileColumnCount}`]
        : [`ss${policy.shorterSide}`, `fc${policy.frameCount}`, `fd${policy.frameDelayMs}`];

  const encodingTokens: string[] = [`fmt${normalizeParamsValue(policy.outputMime)}`];
  switch (policy.outputMime) {
    case "image/jpeg":
      encodingTokens.push(`q${policy.jpegQuality}`);
      break;
    case "image/png":
      encodingTokens.push(`pl${policy.pngCompressionLevel}`);
      break;
    case "image/webp":
      encodingTokens.push(`wq${policy.webpQuality}`, `wl${policy.webpLossless ? 1 : 0}`);
      break;
    case "image/gif":
      encodingTokens.push(
        `mc${policy.gifMaxColors}`,
        `dt${normalizeParamsValue(policy.gifDither)}`,
      );
      break;
  }

  return [PARAMS_VERSION, policy.name, ...sizingTokens, ...encodingTokens].join("-");
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

/**
 * One thumbnail `ensure` has decided to generate, held until every
 * decision has been made. Reconciliation used to dispatch these as it
 * went, which meant the generation total could only be discovered as
 * quickly as the pool drained -- and the pool is exactly what the bar is
 * there to report on. `staleThumbnail` set means this is a regeneration:
 * the old file is deleted inside the job, and it's also what picks the
 * right word for a failure's log line.
 */
/**
 * A pure map from what the policy declares it will produce to the file
 * extension that names it -- the source's own extension/mime type plays no
 * role at all, now that `output_mime` is always required (no inheritance).
 * `jpg`, never `jpeg`, matching the existing single-spelling convention.
 */
const EXTENSION_BY_OUTPUT_MIME: Record<ThumbnailOutputMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function expectedThumbExtension(policy: ThumbnailPolicyGenerateRow): string {
  return EXTENSION_BY_OUTPUT_MIME[policy.outputMime];
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
  const thumbExt = expectedThumbExtension(policy);
  const paramsSegment = expectedParamsSegment(policy);
  const destRelativePath = thumbnailRelativePath(
    decision.relativePath,
    paramsSegment,
    decision.cacheHash!,
    thumbExt,
  );
  const destAbsolutePath = path.join(root, destRelativePath);
  fs.mkdirSync(path.dirname(destAbsolutePath), { recursive: true });
  const tempAbsolutePath = inTreeTempPathPreservingExtension(destAbsolutePath);
  const sourceAbsolutePath = path.join(root, decision.relativePath);

  try {
    if (decision.probed.kind === "image") {
      if (policy.mediaType !== "image") {
        throw new Error(
          `internal error: matched policy media type "${policy.mediaType}" doesn't agree with probed kind "image" for "${decision.relativePath}"`,
        );
      }
      const source = { width: decision.probed.width, height: decision.probed.height };
      const size =
        policy.resizingStrategy === "fit_to_box"
          ? computeContainFitSize(source, { width: policy.imageWidth, height: policy.imageHeight })
          : computeShorterSideFitSize(source, policy.shorterSide);
      await generator.generateImageThumbnail(
        {
          sourcePath: sourceAbsolutePath,
          destPath: tempAbsolutePath,
          width: size.width,
          height: size.height,
          encoding: policy,
        },
        logger,
      );
    } else {
      if (policy.mediaType !== "video") {
        throw new Error(
          `internal error: matched policy media type "${policy.mediaType}" doesn't agree with probed kind "video" for "${decision.relativePath}"`,
        );
      }
      if (policy.outputType === "mosaic") {
        await generator.generateVideoMosaic(
          {
            sourcePath: sourceAbsolutePath,
            destPath: tempAbsolutePath,
            sourceWidth: decision.probed.width,
            sourceHeight: decision.probed.height,
            durationSeconds: decision.probed.durationSeconds,
            tileRowCount: policy.tileRowCount,
            tileColumnCount: policy.tileColumnCount,
            shorterSide: policy.shorterSide,
            encoding: policy,
          },
          logger,
        );
      } else {
        await generator.generateVideoPreview(
          {
            sourcePath: sourceAbsolutePath,
            destPath: tempAbsolutePath,
            sourceWidth: decision.probed.width,
            sourceHeight: decision.probed.height,
            durationSeconds: decision.probed.durationSeconds,
            frameCount: policy.frameCount,
            frameDelayMs: policy.frameDelayMs,
            shorterSide: policy.shorterSide,
            encoding: policy,
          },
          logger,
        );
      }
    }
    fs.renameSync(tempAbsolutePath, destAbsolutePath);
    if (staleThumbnail) deleteThumbnailFile(root, staleThumbnail);
  } catch (error) {
    // Never let discarding the staged file replace the failure that
    // caused it to be discarded. `force: true` swallows ENOENT but not,
    // say, ENAMETOOLONG or EACCES -- and a throw here would substitute a
    // plain Error for the caller's `ThumbnailGenerationError`, which is
    // the only thing that marks a failure as *per-file*. That swap turned
    // one unwritable thumbnail into an aborted run with no summary and no
    // named path, which is exactly how this stayed invisible.
    try {
      fs.rmSync(tempAbsolutePath, { force: true });
    } catch (cleanupError) {
      logger.debug(
        { path: tempAbsolutePath, err: String(cleanupError) },
        "could not remove staged thumbnail after a failed generation",
      );
    }
    throw error;
  }
}

/** How many candidates between published work estimates. */
const PUBLISH_ESTIMATE_EVERY_ROWS = 512;

function expectedThumbnailExists(
  root: string,
  relativePath: string,
  hash: string,
  policy: ThumbnailPolicyGenerateRow,
): boolean {
  return fs.existsSync(
    path.join(
      root,
      thumbnailRelativePath(
        relativePath,
        expectedParamsSegment(policy),
        hash,
        expectedThumbExtension(policy),
      ),
    ),
  );
}

function matchingGenerateGlobs(
  relativePath: string,
  policies: readonly ThumbnailPolicyRow[],
): ThumbnailPolicyGenerateRow[] {
  return policies.filter(
    (policy): policy is ThumbnailPolicyGenerateRow =>
      policy.action === "generate" && matchesAnyGlob(relativePath, [policy.glob]).matched,
  );
}

function hasMatchingSkipGlob(
  relativePath: string,
  policies: readonly ThumbnailPolicyRow[],
): boolean {
  return policies.some(
    (policy) => policy.action === "skip" && matchesAnyGlob(relativePath, [policy.glob]).matched,
  );
}

function shouldProcessSource(
  mode: ThumbnailRunMode,
  root: string,
  relativePath: string,
  hash: string | null,
  policies: readonly ThumbnailPolicyRow[],
): boolean {
  if (!anyGlobMatches(relativePath, policies)) return false;
  if (mode !== "ensure" || hash === null) return true;
  if (hasMatchingSkipGlob(relativePath, policies)) return true;
  return matchingGenerateGlobs(relativePath, policies).some(
    (policy) => !expectedThumbnailExists(root, relativePath, hash, policy),
  );
}

async function enumerateThumbnailWork(
  root: string,
  walkRoot: string,
  literalPrefix: string,
  mode: ThumbnailRunMode,
  glob: string | undefined,
  ignoreGlobs: readonly string[],
  policies: readonly ThumbnailPolicyRow[],
  cacheRepo: CacheEntriesRepository,
  onEstimate: ((total: number) => void) | undefined,
  logger: Logger,
  control: EnumerationControl,
): Promise<void> {
  if (!onEstimate) return;

  const generatePolicies = policies.filter(
    (p): p is ThumbnailPolicyGenerateRow => p.action === "generate",
  );
  let estimated = 0;
  let sincePublish = 0;

  try {
    for await (const fsEntry of walk(walkRoot)) {
      if (control.stop) return;
      if (fsEntry.type !== "file") continue;

      const relativePath = literalPrefix ? `${literalPrefix}/${fsEntry.path}` : fsEntry.path;
      if (isUnderThumbnailDir(relativePath)) continue;
      if (glob && !matchesAnyGlob(relativePath, [glob]).matched) continue;
      if (matchesAnyGlob(relativePath, ignoreGlobs).matched) continue;

      const cacheRow = cacheRepo.get(relativePath);
      const hash = cacheRow?.hash ?? null;
      const relevantPolicies = generatePolicies.filter(
        (policy) => matchesAnyGlob(relativePath, [policy.glob]).matched,
      );
      if (
        relevantPolicies.length > 0 &&
        shouldProcessSource(mode, root, relativePath, hash, policies)
      ) {
        estimated++;
      }

      if (++sincePublish >= PUBLISH_ESTIMATE_EVERY_ROWS) {
        sincePublish = 0;
        onEstimate(estimated);
      }
    }
    onEstimate(estimated);
  } catch (err) {
    // Swallowed on purpose, same contract as every other enumeration pass
    // in this codebase: this exists only to make the bar useful sooner,
    // never to be a reason `ensure` itself fails.
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "thumbnail work estimate failed -- continuing without one",
    );
  }
}

async function forEachThumbnailForOriginal(
  root: string,
  originalRelativePath: string,
  visit: (thumbnail: ExistingThumbnailFile) => void | Promise<void>,
): Promise<number> {
  const originalDir = path.dirname(originalRelativePath);
  const thumbnailDir = path.join(
    root,
    originalDir === "." ? THUMBNAIL_DIR_NAME : originalDir,
    originalDir === "." ? "" : THUMBNAIL_DIR_NAME,
  );

  let entries: fs.Dir;
  try {
    entries = await fs.promises.opendir(thumbnailDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  let found = 0;
  for await (const dirent of entries) {
    if (!dirent.isFile()) continue;
    const thumbnailRelativePath =
      originalDir === "."
        ? `${THUMBNAIL_DIR_NAME}/${dirent.name}`
        : `${originalDir}/${THUMBNAIL_DIR_NAME}/${dirent.name}`;
    const thumbnail = parseThumbnailEntry(thumbnailRelativePath);
    if (!thumbnail || thumbnail.originalRelativePath !== originalRelativePath) continue;
    found++;
    await visit(thumbnail);
  }
  return found;
}

function removeIfCleanup(
  root: string,
  mode: ThumbnailRunMode,
  thumbnail: ExistingThumbnailFile,
): void {
  if (mode === "cleanup") deleteThumbnailFile(root, thumbnail);
}

async function processStubSource(
  root: string,
  mode: ThumbnailRunMode,
  relativePath: string,
  cacheHash: string | null,
  stats: ThumbnailScanStats,
  deleteStaleStubPreviews: boolean,
): Promise<void> {
  if (cacheHash === null) {
    stats.missingCacheEntry++;
    return;
  }

  let hasMatchingHash = false;
  const existingCount = await forEachThumbnailForOriginal(root, relativePath, (thumbnail) => {
    if (thumbnail.hash === cacheHash) hasMatchingHash = true;
  });

  if (hasMatchingHash) {
    stats.stubbedPreserved++;
    let keptOne = false;
    await forEachThumbnailForOriginal(root, relativePath, (thumbnail) => {
      if (!keptOne && thumbnail.hash === cacheHash) {
        keptOne = true;
        return;
      }
      stats.toDelete++;
      removeIfCleanup(root, mode, thumbnail);
    });
    return;
  }

  if (existingCount === 0) {
    stats.stubbedOriginal++;
    return;
  }

  await forEachThumbnailForOriginal(root, relativePath, (thumbnail) => {
    stats.staleStubPreviews.push({
      path: relativePath,
      thumbnailPath: thumbnail.relativePath,
    });
    if (mode === "cleanup" && deleteStaleStubPreviews) deleteThumbnailFile(root, thumbnail);
  });
}

interface PolicyThumbnailState {
  exact?: ExistingThumbnailFile | undefined;
  stale?: ExistingThumbnailFile | undefined;
}

async function reconcileProbedSource(
  root: string,
  mode: ThumbnailRunMode,
  decision: ProvisionalDecisionProbed | undefined,
  relativePath: string,
  generator: ThumbnailGenerator,
  logger: Logger,
  stats: ThumbnailScanStats,
  onActivity?: (verb: string, relativePath: string) => void,
): Promise<boolean> {
  if (!decision || decision.resolution.action === "skip") {
    await forEachThumbnailForOriginal(root, relativePath, (thumbnail) => {
      stats.toDelete++;
      removeIfCleanup(root, mode, thumbnail);
    });
    return false;
  }

  if (decision.cacheHash === null) {
    stats.missingCacheEntry++;
    return false;
  }

  const states = new Map<string, PolicyThumbnailState>(
    decision.resolution.policies.map((policy) => [policy.name, {}]),
  );
  const policiesByName = new Map(
    decision.resolution.policies.map((policy) => [policy.name, policy]),
  );

  await forEachThumbnailForOriginal(root, relativePath, (thumbnail) => {
    const policy = policiesByName.get(thumbnail.policyName);
    if (!policy) {
      stats.toDelete++;
      removeIfCleanup(root, mode, thumbnail);
      return;
    }

    const state = states.get(policy.name)!;
    const exact =
      thumbnail.hash === decision.cacheHash &&
      thumbnail.thumbExt === expectedThumbExtension(policy) &&
      thumbnail.paramsSegment === expectedParamsSegment(policy);

    if (exact && !state.exact) {
      if (state.stale) {
        stats.toDelete++;
        removeIfCleanup(root, mode, state.stale);
        state.stale = undefined;
      }
      state.exact = thumbnail;
      return;
    }

    if (!exact && !state.exact && !state.stale) {
      state.stale = thumbnail;
      return;
    }

    stats.toDelete++;
    removeIfCleanup(root, mode, thumbnail);
  });

  let generated = false;
  for (const policy of decision.resolution.policies) {
    const state = states.get(policy.name)!;
    if (state.exact) {
      stats.upToDate++;
      continue;
    }

    if (state.stale) stats.toRegenerate++;
    else stats.toGenerate++;
    if (mode !== "ensure") continue;

    onActivity?.("generating", relativePath);
    try {
      await generateForDecision(root, decision, policy, state.stale, generator, logger);
      generated = true;
      onActivity?.("generated", relativePath);
    } catch (err) {
      if (!(err instanceof ThumbnailGenerationError)) throw err;
      stats.errors++;
      stats.failures.push({ path: relativePath, reason: err.message });
      logger.warn(
        { path: relativePath, err: err.message },
        state.stale
          ? "thumbnail regeneration failed -- skipping"
          : "thumbnail generation failed -- skipping",
      );
    }
  }
  return generated;
}

async function sweepUnprocessedThumbnails(
  root: string,
  walkRoot: string,
  literalPrefix: string,
  mode: ThumbnailRunMode,
  glob: string | undefined,
  ignoreGlobs: readonly string[],
  policies: readonly ThumbnailPolicyRow[],
  stats: ThumbnailScanStats,
  onDiscovered: () => void,
  onCompleted: () => void,
  onActivity?: (verb: string, relativePath: string) => void,
): Promise<void> {
  for await (const fsEntry of walk(walkRoot)) {
    if (fsEntry.type !== "file") continue;
    const relativePath = literalPrefix ? `${literalPrefix}/${fsEntry.path}` : fsEntry.path;
    const thumbnail = parseThumbnailEntry(relativePath);
    if (!thumbnail) continue;

    const originalAbsolutePath = path.join(root, thumbnail.originalRelativePath);
    const originalExists =
      fs.existsSync(originalAbsolutePath) || fs.existsSync(`${originalAbsolutePath}.stub`);
    const sourceWasProcessed =
      originalExists &&
      (!glob || matchesAnyGlob(thumbnail.originalRelativePath, [glob]).matched) &&
      !matchesAnyGlob(thumbnail.originalRelativePath, ignoreGlobs).matched &&
      anyGlobMatches(thumbnail.originalRelativePath, policies);
    if (sourceWasProcessed) continue;

    onDiscovered();
    onActivity?.("processing", thumbnail.relativePath);
    stats.toDelete++;
    removeIfCleanup(root, mode, thumbnail);
    onActivity?.("processed", thumbnail.relativePath);
    onCompleted();
  }
}

/**
 * Two concurrent streaming passes, matching update_cache's
 * enumeration/execution shape. The advisory pass only walks, matches
 * globs, reads cache hashes, and checks deterministic thumbnail paths; it
 * never probes media. The authoritative pass repeats those cheap filters
 * and dispatches one bounded job per source. That job probes, resolves
 * MIME/skip policy, reconciles only that source's sibling `_thumbnail`
 * entries, and immediately generates/reports/deletes as `mode` requires.
 * No source decisions, generation jobs, or thumbnail paths are retained
 * across sources.
 *
 * Progress is one unit per source, even when several generate policies
 * produce several outputs. Every dispatched source resolves its unit in a
 * `finally`, including MIME/skip rejection and handled generation failure.
 * A final streaming thumbnail sweep handles missing originals and sources
 * excluded by glob/ignore/policy without building an orphan map.
 *
 * `ignoreGlobs` (`IgnorePoliciesRepository.listGlobs()`, same precedent as
 * `update_cache`/`sanity_check`/`apply-remote-changes`'s own ignore-policy
 * consultation) is checked as a cheap, in-memory pre-filter right beside
 * the thumbnail-policy one -- a matching path is skipped entirely, never
 * probed or policy-resolved, exactly as if it matched no thumbnail policy
 * glob at all. Deliberately unconditional, unlike `update_cache`'s own
 * "only an uncommitted `created` row" carve-out: a thumbnail is a
 * local-only artifact with no cross-machine propagation concern, so
 * there's no analogous reason to spare an already-thumbnailed path once
 * its glob is ignored. An existing thumbnail for a newly-ignored path is
 * therefore never explicitly deleted here -- it's simply never claimed,
 * so it falls through the ordinary unclaimed-orphan sweep below and is
 * counted under `toDelete` like any other orphan.
 */
export async function scanThumbnails(
  root: string,
  mode: ThumbnailRunMode,
  glob: string | undefined,
  cacheRepo: CacheEntriesRepository,
  policies: readonly ThumbnailPolicyRow[],
  ignoreGlobs: readonly string[],
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
  onWorkEstimate?: (total: number) => void,
  onWorkProgress?: (discovered: number, completed: number, final: boolean) => void,
  onActivity?: (verb: string, relativePath: string) => void,
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
    failures: [],
  };

  const literalPrefix = glob ? literalPrefixOf(glob) : "";
  const walkRoot = literalPrefix ? path.join(root, literalPrefix) : root;
  if (!fs.existsSync(walkRoot)) return stats; // --glob's literal prefix doesn't exist -- nothing to do, not an error

  const poolErrors = createPoolErrorBox();
  const estimationControl: EnumerationControl = { stop: false };
  const estimation = enumerateThumbnailWork(
    root,
    walkRoot,
    literalPrefix,
    mode,
    glob,
    ignoreGlobs,
    policies,
    cacheRepo,
    onWorkEstimate,
    logger,
    estimationControl,
  );

  let discovered = 0;
  let completed = 0;
  const discoveredOne = (): void => {
    discovered++;
    onWorkProgress?.(discovered, completed, false);
  };
  const completedOne = (): void => {
    completed++;
    onWorkProgress?.(discovered, completed, false);
  };

  try {
    for await (const fsEntry of walk(walkRoot)) {
      if (fsEntry.type !== "file") continue;

      const relativePath = literalPrefix ? `${literalPrefix}/${fsEntry.path}` : fsEntry.path;
      if (isUnderThumbnailDir(relativePath)) continue;
      if (glob && !matchesAnyGlob(relativePath, [glob]).matched) continue;
      if (matchesAnyGlob(relativePath, ignoreGlobs).matched) continue;
      if (!anyGlobMatches(relativePath, policies)) continue;

      const cacheHash = cacheRepo.get(relativePath)?.hash ?? null;
      if (!shouldProcessSource(mode, root, relativePath, cacheHash, policies)) {
        for (const policy of matchingGenerateGlobs(relativePath, policies)) {
          if (cacheHash && expectedThumbnailExists(root, relativePath, cacheHash, policy)) {
            stats.upToDate++;
          }
        }
        continue;
      }

      discoveredOne();
      if (fsEntry.representation === "stub") {
        onActivity?.("processing", relativePath);
        await processStubSource(
          root,
          mode,
          relativePath,
          cacheHash,
          stats,
          deleteStaleStubPreviews,
        );
        completedOne();
        continue;
      }

      await waitForRoom(pool, poolQueueLimit);
      dispatchTracked(pool, poolErrors, async () => {
        onActivity?.("processing", relativePath);
        try {
          const decision = await classifyProbed(relativePath, root, cacheRepo, policies, prober);
          const generated = await reconcileProbedSource(
            root,
            mode,
            decision,
            relativePath,
            generator,
            logger,
            stats,
            onActivity,
          );
          if (!generated) onActivity?.("processed", relativePath);
        } finally {
          completedOne();
        }
        logger.debug({ pool: "thumbnail", inFlight: pool.pending, queued: pool.size }, "completed");
      });
      logger.debug({ pool: "thumbnail", inFlight: pool.pending, queued: pool.size }, "dispatched");
    }

    await pool.onIdle();
    throwIfPoolErrored(poolErrors);

    await sweepUnprocessedThumbnails(
      root,
      walkRoot,
      literalPrefix,
      mode,
      glob,
      ignoreGlobs,
      policies,
      stats,
      discoveredOne,
      completedOne,
      onActivity,
    );
  } finally {
    estimationControl.stop = true;
    await estimation;
    onWorkProgress?.(discovered, completed, true);
  }

  return stats;
}
