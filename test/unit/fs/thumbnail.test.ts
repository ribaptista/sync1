import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import PQueue from "p-queue";
import { openCacheDb, openStateDb } from "../../../src/db/connection.js";
import { CacheEntriesRepository } from "../../../src/db/repositories/cache-entries-repository.js";
import {
  ThumbnailPoliciesRepository,
  type ThumbnailPolicyCreateInput,
} from "../../../src/db/repositories/thumbnail-policies-repository.js";
import { IgnorePoliciesRepository } from "../../../src/db/repositories/ignore-policies-repository.js";
import {
  scanThumbnails,
  isUnderThumbnailDir,
  type ThumbnailScanStats,
} from "../../../src/fs/thumbnail.js";
import type { MediaProber, ProbedMedia } from "../../../src/media/probe.js";
import {
  ThumbnailGenerationError,
  type ThumbnailGenerator,
} from "../../../src/media/thumbnail-generate.js";

const silentLogger = {
  debug: () => {},
  warn: () => {},
} as unknown as import("../../../src/logger.js").Logger;

let root: string;
let stateDb: ReturnType<typeof openStateDb>;
let cacheDb: ReturnType<typeof openCacheDb>;
let cacheRepo: CacheEntriesRepository;
let policiesRepo: ThumbnailPoliciesRepository;
let ignorePoliciesRepo: IgnorePoliciesRepository;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-thumbnail-test-"));
  stateDb = openStateDb(":memory:");
  cacheDb = openCacheDb(":memory:");
  cacheRepo = new CacheEntriesRepository(cacheDb);
  policiesRepo = new ThumbnailPoliciesRepository(stateDb);
  ignorePoliciesRepo = new IgnorePoliciesRepository(stateDb);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  stateDb.close();
  cacheDb.close();
});

function seedCache(relativePath: string, hash: string): void {
  cacheRepo.upsert({
    path: relativePath,
    type: "file",
    mtime: 0,
    hash,
    size: 1,
    state: "unchanged",
    parent_state_version: null,
  });
}

function writeFile(relativePath: string, content = "x"): void {
  const abs = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function writeStub(relativePath: string, hash: string): void {
  const abs = path.join(root, `${relativePath}.stub`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `blake2b:${hash}`);
}

const GENERATE_JPEG = {
  name: "img",
  action: "generate",
  mediaType: "image",
  resizingStrategy: "fit_to_box",
  mimeTypes: ["image/jpeg"],
  imageWidth: 320,
  imageHeight: 240,
  outputMime: "image/jpeg",
  jpegQuality: 80,
} satisfies Omit<
  Extract<
    ThumbnailPolicyCreateInput,
    { mediaType: "image"; resizingStrategy: "fit_to_box"; outputMime: "image/jpeg" }
  >,
  "glob"
>;

function createGeneratePolicy(glob: string, overrides: Partial<typeof GENERATE_JPEG> = {}): number {
  return policiesRepo.create({ ...GENERATE_JPEG, glob, ...overrides });
}

// Matches expectedParamsSegment's own encoding for GENERATE_JPEG's default
// name+fields ("img"; imageWidth 320, imageHeight 240, output mime
// image/jpeg, jpegQuality 80) and for the video policy created directly in
// the mosaic test below ("vid"; tileRowCount 3, tileColumnCount 3,
// shorterSide 48, output mime image/jpeg, jpegQuality 80) -- every
// thumbnail filename asserted against in this file now carries one of
// these two segments, since parseThumbnailEntry requires a shape-valid
// params segment to recognize a thumbnail file at all.
const IMAGE_PARAMS = "p2-img-iw320-ih240-fmtimage_jpeg-q80";
const VIDEO_PARAMS = "p2-vid-ss48-tr3-tc3-fmtimage_jpeg-q80";

function createSkipPolicy(glob: string, mimeTypes = ["image/jpeg"], name = "skip"): number {
  return policiesRepo.create({ name, glob, action: "skip", mimeTypes });
}

function fakeProber(entries: Record<string, ProbedMedia>): MediaProber {
  const detectMedia = vi.fn(async (absolutePath: string): Promise<ProbedMedia | undefined> => {
    const relativePath = path.relative(root, absolutePath);
    return entries[relativePath];
  });
  return { detectMedia };
}

function fakeGenerator(failFor: Set<string> = new Set()): ThumbnailGenerator & {
  imageCalls: { sourcePath: string; destPath: string; width: number; height: number }[];
  videoCalls: { sourcePath: string; destPath: string }[];
  gifCalls: { sourcePath: string; destPath: string }[];
} {
  const imageCalls: { sourcePath: string; destPath: string; width: number; height: number }[] = [];
  const videoCalls: { sourcePath: string; destPath: string }[] = [];
  const gifCalls: { sourcePath: string; destPath: string }[] = [];
  return {
    imageCalls,
    videoCalls,
    gifCalls,
    async generateImageThumbnail(input) {
      if (failFor.has(input.sourcePath)) {
        throw new ThumbnailGenerationError(`simulated failure for ${input.sourcePath}`);
      }
      imageCalls.push(input);
      fs.mkdirSync(path.dirname(input.destPath), { recursive: true });
      fs.writeFileSync(input.destPath, "thumb");
    },
    async generateVideoMosaic(input) {
      if (failFor.has(input.sourcePath)) {
        throw new ThumbnailGenerationError(`simulated failure for ${input.sourcePath}`);
      }
      videoCalls.push(input);
      fs.mkdirSync(path.dirname(input.destPath), { recursive: true });
      fs.writeFileSync(input.destPath, "mosaic");
    },
    async generateVideoPreview(input) {
      if (failFor.has(input.sourcePath)) {
        throw new ThumbnailGenerationError(`simulated failure for ${input.sourcePath}`);
      }
      gifCalls.push(input);
      fs.mkdirSync(path.dirname(input.destPath), { recursive: true });
      fs.writeFileSync(input.destPath, "gif");
    },
  };
}

function run(
  mode: "state" | "ensure" | "cleanup",
  glob: string | undefined,
  prober: MediaProber,
  generator: ThumbnailGenerator,
  deleteStaleStubPreviews = false,
): Promise<ThumbnailScanStats> {
  const pool = new PQueue({ concurrency: 4 });
  return scanThumbnails(
    root,
    mode,
    glob,
    cacheRepo,
    policiesRepo.list(),
    ignorePoliciesRepo.listGlobs(),
    prober,
    generator,
    silentLogger,
    pool,
    8,
    deleteStaleStubPreviews,
  );
}

const JPEG_IMAGE: ProbedMedia = { kind: "image", mimeType: "image/jpeg", width: 800, height: 600 };
const CR2_IMAGE: ProbedMedia = {
  kind: "image",
  mimeType: "image/x-canon-cr2",
  width: 3906,
  height: 2602,
};

describe("isUnderThumbnailDir", () => {
  it("is true for a file directly inside a root-level _thumbnail/ dir", () => {
    expect(isUnderThumbnailDir("_thumbnail/photo.jpg.p1-iw16-ih16-q80.abc.jpg")).toBe(true);
  });

  it("is true for a file inside a nested _thumbnail/ dir", () => {
    expect(isUnderThumbnailDir("Photos/2024/_thumbnail/photo.jpg.p1-iw16-ih16-q80.abc.jpg")).toBe(
      true,
    );
  });

  it("is false for an ordinary file with no _thumbnail segment at all", () => {
    expect(isUnderThumbnailDir("Photos/2024/photo.jpg")).toBe(false);
  });

  it("is false when _thumbnail only appears as part of a longer segment name, not as its own segment", () => {
    expect(isUnderThumbnailDir("my_thumbnail_archive/photo.jpg")).toBe(false);
  });

  it("is true for the _thumbnail directory entry itself", () => {
    expect(isUnderThumbnailDir("_thumbnail")).toBe(true);
  });
});

describe("scanThumbnails", () => {
  it("reports up-to-date when an existing thumbnail's hash matches cache.db's current hash", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("photo.jpg");
    seedCache("photo.jpg", "abc123");
    writeFile(`_thumbnail/photo.jpg.${IMAGE_PARAMS}.abc123.jpg`);

    const prober = fakeProber({ "photo.jpg": JPEG_IMAGE });
    const generator = fakeGenerator();
    const stats = await run("ensure", undefined, prober, generator);

    expect(stats).toMatchObject({ upToDate: 1, toGenerate: 0, toRegenerate: 0, toDelete: 0 });
    expect(generator.imageCalls).toHaveLength(0);
    expect(prober.detectMedia).not.toHaveBeenCalled();
  });

  it("reports toGenerate for a new candidate with no existing thumbnail, and ensure generates it", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("new.jpg");
    seedCache("new.jpg", "def456");

    const prober = fakeProber({ "new.jpg": JPEG_IMAGE });
    const generator = fakeGenerator();
    const stateStats = await run("state", undefined, prober, generator);
    expect(stateStats).toMatchObject({ toGenerate: 1, upToDate: 0 });
    expect(generator.imageCalls).toHaveLength(0); // state never writes anything

    const ensureStats = await run("ensure", undefined, prober, generator);
    expect(ensureStats).toMatchObject({ toGenerate: 1 });
    expect(generator.imageCalls).toHaveLength(1);
    expect(generator.imageCalls[0]).toMatchObject({ width: 320, height: 240 });
    // Generation stages into an opaque temp sibling -- named independently
    // of the destination, so only its directory and extension are its
    // caller's business. The destination itself is asserted on disk below,
    // after the rename that publishes it.
    expect(generator.imageCalls[0]!.destPath).toMatch(
      new RegExp(`^${path.join(root, "_thumbnail")}/\\.sync1-tmp-[0-9a-f]{32}\\.jpg$`),
    );
    expect(fs.existsSync(path.join(root, `_thumbnail/new.jpg.${IMAGE_PARAMS}.def456.jpg`))).toBe(
      true,
    );
  });

  /**
   * The regression this file's staging-path shape exists for. A temp name
   * built by *extending* the destination's own is longer than the
   * destination, so a source whose final thumbnail name is legal could
   * still have an illegal staging name -- a real 239-byte thumbnail name
   * became a 258-byte temp, past the 255-byte filename limit, and that
   * file could never be generated on any run, ever.
   */
  it("generates for a source whose thumbnail name sits just inside the 255-byte filename limit", async () => {
    // 196 + ".jpg" = a 200-byte source name, so the final thumbnail name
    // lands at 245 bytes -- legal, but only 10 bytes of headroom.
    const sourceName = `${"x".repeat(196)}.jpg`;
    const thumbnailName = `${sourceName}.${IMAGE_PARAMS}.longhash.jpg`;
    expect(Buffer.byteLength(thumbnailName)).toBeGreaterThan(237);
    expect(Buffer.byteLength(thumbnailName)).toBeLessThanOrEqual(255);

    createGeneratePolicy("*.jpg");
    writeFile(sourceName);
    seedCache(sourceName, "longhash");

    const generator = fakeGenerator();
    const stats = await run(
      "ensure",
      undefined,
      fakeProber({ [sourceName]: JPEG_IMAGE }),
      generator,
    );

    expect(stats).toMatchObject({ toGenerate: 1, errors: 0 });
    expect(fs.existsSync(path.join(root, "_thumbnail", thumbnailName))).toBe(true);
  });

  /**
   * Over the limit the source is simply un-thumbnailable, and the only fix
   * is renaming it -- but that has to be reported per file, not thrown.
   * The destination name is derived from the source's own filename, so a
   * name the filesystem rejects is a fact about that one source; letting
   * the raw fs error escape reached the pool error box and aborted the
   * entire run.
   */
  it("tallies a source whose thumbnail name exceeds the filename limit, without aborting the run", async () => {
    const tooLongName = `${"y".repeat(240)}.jpg`;
    createGeneratePolicy("*.jpg");
    writeFile(tooLongName);
    writeFile("fine.jpg");
    seedCache(tooLongName, "hash1");
    seedCache("fine.jpg", "hash2");

    const generator = fakeGenerator();
    const stats = await run(
      "ensure",
      undefined,
      fakeProber({ [tooLongName]: JPEG_IMAGE, "fine.jpg": JPEG_IMAGE }),
      generator,
    );

    expect(stats.errors).toBe(1);
    expect(stats.failures).toHaveLength(1);
    expect(stats.failures[0]!.path).toBe(tooLongName);
    expect(stats.failures[0]!.reason).toMatch(/filesystem rejects|rename the source/);
    // The healthy source in the same run still published.
    expect(fs.existsSync(path.join(root, `_thumbnail/fine.jpg.${IMAGE_PARAMS}.hash2.jpg`))).toBe(
      true,
    );
  });

  it("reports toRegenerate for a stale existing thumbnail, and ensure deletes the old one before generating the new one", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("changed.jpg");
    seedCache("changed.jpg", "newhash");
    writeFile(`_thumbnail/changed.jpg.${IMAGE_PARAMS}.oldhash.jpg`);

    const prober = fakeProber({ "changed.jpg": JPEG_IMAGE });
    const generator = fakeGenerator();
    const stats = await run("ensure", undefined, prober, generator);

    expect(stats).toMatchObject({ toRegenerate: 1, upToDate: 0 });
    expect(
      fs.existsSync(path.join(root, `_thumbnail/changed.jpg.${IMAGE_PARAMS}.oldhash.jpg`)),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(root, `_thumbnail/changed.jpg.${IMAGE_PARAMS}.newhash.jpg`)),
    ).toBe(true);
  });

  it("keeps a stale thumbnail and removes the staged output when regeneration fails", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("changed.jpg");
    seedCache("changed.jpg", "newhash");
    const staleRelativePath = `_thumbnail/changed.jpg.${IMAGE_PARAMS}.oldhash.jpg`;
    writeFile(staleRelativePath);

    const sourcePath = path.join(root, "changed.jpg");
    const generator = fakeGenerator(new Set([sourcePath]));
    const stats = await run(
      "ensure",
      undefined,
      fakeProber({ "changed.jpg": JPEG_IMAGE }),
      generator,
    );

    expect(stats).toMatchObject({ toRegenerate: 1, errors: 1 });
    expect(fs.existsSync(path.join(root, staleRelativePath))).toBe(true);
    expect(fs.readdirSync(path.join(root, "_thumbnail"))).toEqual([
      path.basename(staleRelativePath),
    ]);
  });

  it("regenerates when a policy's own configured parameters change, even though the original file's content hash hasn't", async () => {
    // This is the actual bug the params-segment filename encoding fixes:
    // before it, a filename was keyed only on content hash, so a policy
    // edit (jpeg quality, image box, tile size) with the file itself
    // untouched left the stale thumbnail looking "up to date" forever.
    const policyId = createGeneratePolicy("*.jpg", { imageWidth: 320, imageHeight: 240 });
    writeFile("photo.jpg");
    seedCache("photo.jpg", "samehash");
    writeFile(`_thumbnail/photo.jpg.${IMAGE_PARAMS}.samehash.jpg`);

    const prober = fakeProber({ "photo.jpg": JPEG_IMAGE });
    const upToDateStats = await run("state", undefined, prober, fakeGenerator());
    expect(upToDateStats).toMatchObject({ upToDate: 1, toRegenerate: 0 });

    policiesRepo.update(policyId, { imageWidth: 200 });
    const afterConfigChange = await run("state", undefined, prober, fakeGenerator());
    expect(afterConfigChange).toMatchObject({ upToDate: 0, toRegenerate: 1 });

    const generator = fakeGenerator();
    const ensureStats = await run("ensure", undefined, prober, generator);
    expect(ensureStats).toMatchObject({ toRegenerate: 1 });
    expect(
      fs.existsSync(path.join(root, `_thumbnail/photo.jpg.${IMAGE_PARAMS}.samehash.jpg`)),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(root, "_thumbnail/photo.jpg.p2-img-iw200-ih240-fmtimage_jpeg-q80.samehash.jpg"),
      ),
    ).toBe(true);
  });

  it("recognizes a pre-existing p1 thumbnail as this policy's own stale output, regenerating it under p2 rather than orphaning it", async () => {
    // The p1->p2 filename-grammar bump must not turn every real vault's
    // existing thumbnails invisible: PARAMS_SEGMENT_RE still recognizes a
    // p1 segment, and the policy-name lookup (split("-")[1]) parses it
    // identically to a p2 one, so it's found, matched by name, and
    // regenerated -- never left behind as an unrecognized/orphaned file.
    createGeneratePolicy("*.jpg");
    writeFile("photo.jpg");
    seedCache("photo.jpg", "samehash");
    // Hand-written in the OLD p1 shape (digits-only fields, no fmt/q token
    // split) -- what a real vault's thumbnail from before this change
    // would look like, for the same policy ("img") and the same content
    // hash.
    writeFile("_thumbnail/photo.jpg.p1-img-iw320-ih240-q80.samehash.jpg");

    const stateStats = await run(
      "state",
      undefined,
      fakeProber({ "photo.jpg": JPEG_IMAGE }),
      fakeGenerator(),
    );
    // Not "up to date" (the p1 file's whole segment doesn't match the
    // freshly-computed p2 one) but also not an unrecognized/orphaned file
    // -- it's this same policy's own prior output, just under the old
    // grammar, so it's toRegenerate.
    expect(stateStats).toMatchObject({ upToDate: 0, toRegenerate: 1, toDelete: 0 });

    const ensureStats = await run(
      "ensure",
      undefined,
      fakeProber({ "photo.jpg": JPEG_IMAGE }),
      fakeGenerator(),
    );
    expect(ensureStats).toMatchObject({ toRegenerate: 1 });
    // The old p1 file is deleted as part of the same regeneration job...
    expect(
      fs.existsSync(path.join(root, "_thumbnail/photo.jpg.p1-img-iw320-ih240-q80.samehash.jpg")),
    ).toBe(false);
    // ...and its p2 replacement is written in its place, no manual cleanup
    // needed for the one-time upgrade.
    expect(
      fs.existsSync(path.join(root, `_thumbnail/photo.jpg.${IMAGE_PARAMS}.samehash.jpg`)),
    ).toBe(true);
  });

  it("never recognizes a pre-existing thumbnail filename that has no params segment, leaving it untouched even under cleanup", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("photo.jpg");
    seedCache("photo.jpg", "abc123");
    // The pre-this-change three-dot-part shape -- fewer than the four
    // parts parseThumbnailEntry now requires, so this is never reverse-
    // parsed as belonging to "photo.jpg" at all, not even as an orphan.
    writeFile("_thumbnail/photo.jpg.abc123.jpg");

    const prober = fakeProber({ "photo.jpg": JPEG_IMAGE });
    const stats = await run("state", undefined, prober, fakeGenerator());
    // Not recognized as an existing thumbnail for photo.jpg, so it's
    // treated as if none exists at all.
    expect(stats).toMatchObject({ toGenerate: 1, upToDate: 0, toDelete: 0 });

    const cleanupStats = await run("cleanup", undefined, prober, fakeGenerator());
    expect(cleanupStats).toMatchObject({ toDelete: 0 });
    expect(fs.existsSync(path.join(root, "_thumbnail/photo.jpg.abc123.jpg"))).toBe(true);
  });

  it("reports toDelete for a skip-matched original with an existing thumbnail, and only cleanup removes it", async () => {
    createSkipPolicy("private/**");
    writeFile("private/secret.jpg");
    seedCache("private/secret.jpg", "abc");
    writeFile(`private/_thumbnail/secret.jpg.${IMAGE_PARAMS}.abc.jpg`);

    const prober = fakeProber({ "private/secret.jpg": JPEG_IMAGE });

    const ensureStats = await run("ensure", undefined, prober, fakeGenerator());
    expect(ensureStats).toMatchObject({ toDelete: 1 });
    expect(
      fs.existsSync(path.join(root, `private/_thumbnail/secret.jpg.${IMAGE_PARAMS}.abc.jpg`)),
    ).toBe(true); // ensure never touches bucket d

    const cleanupStats = await run("cleanup", undefined, prober, fakeGenerator());
    expect(cleanupStats).toMatchObject({ toDelete: 1 });
    expect(
      fs.existsSync(path.join(root, `private/_thumbnail/secret.jpg.${IMAGE_PARAMS}.abc.jpg`)),
    ).toBe(false);
  });

  it("skip beats generate even when a generate policy also matches", async () => {
    createGeneratePolicy("secret.jpg");
    createSkipPolicy("secret.jpg");
    writeFile("secret.jpg");
    seedCache("secret.jpg", "abc");

    const prober = fakeProber({ "secret.jpg": JPEG_IMAGE });
    const generator = fakeGenerator();
    const stats = await run("ensure", undefined, prober, generator);

    expect(stats).toMatchObject({ toGenerate: 0, toRegenerate: 0, upToDate: 0 });
    expect(generator.imageCalls).toHaveLength(0);
  });

  it("every matching 'generate' policy produces its own thumbnail -- no priority, no single winner", async () => {
    createGeneratePolicy("*.jpg", { name: "big", imageWidth: 999, imageHeight: 999 });
    createGeneratePolicy("*.jpg", { name: "small", imageWidth: 100, imageHeight: 100 });
    writeFile("both.jpg");
    seedCache("both.jpg", "abc");

    const prober = fakeProber({ "both.jpg": JPEG_IMAGE });
    const generator = fakeGenerator();
    const progress: { discovered: number; completed: number; final: boolean }[] = [];
    const pool = new PQueue({ concurrency: 4 });
    const stats = await scanThumbnails(
      root,
      "ensure",
      undefined,
      cacheRepo,
      policiesRepo.list(),
      ignorePoliciesRepo.listGlobs(),
      prober,
      generator,
      silentLogger,
      pool,
      8,
      false,
      () => {},
      (discovered, completed, final) => progress.push({ discovered, completed, final }),
    );

    expect(stats).toMatchObject({ toGenerate: 2, toRegenerate: 0, upToDate: 0, toDelete: 0 });
    expect(generator.imageCalls).toHaveLength(2);
    expect(progress.at(-1)).toEqual({ discovered: 1, completed: 1, final: true });
    const byWidth = new Map(generator.imageCalls.map((c) => [c.width, c]));
    // JPEG_IMAGE is 800x600 (4:3) -- contain-fit into each policy's own box.
    expect(byWidth.get(999)).toMatchObject({
      height: 749,
    });
    expect(byWidth.get(100)).toMatchObject({
      height: 75,
    });
    // Each policy's own output, published under its own params segment --
    // asserted on disk, since the staging name each was written through
    // carries nothing identifying back.
    expect(
      fs.existsSync(
        path.join(root, "_thumbnail/both.jpg.p2-big-iw999-ih999-fmtimage_jpeg-q80.abc.jpg"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(root, "_thumbnail/both.jpg.p2-small-iw100-ih100-fmtimage_jpeg-q80.abc.jpg"),
      ),
    ).toBe(true);

    // A second run finds both up to date, and deletes neither -- each
    // policy's own output is claimed by that same policy, not treated as
    // an extra/orphan of the other.
    const second = await run("state", undefined, fakeProber({ "both.jpg": JPEG_IMAGE }), generator);
    expect(second).toMatchObject({ upToDate: 2, toGenerate: 0, toDelete: 0 });
  });

  it("deleting one of two matching policies regenerates nothing and orphans only that policy's own thumbnail", async () => {
    createGeneratePolicy("*.jpg"); // default name "img", matching IMAGE_PARAMS below
    const dropId = createGeneratePolicy("*.jpg", {
      name: "drop",
      imageWidth: 100,
      imageHeight: 100,
    });
    writeFile("both.jpg");
    seedCache("both.jpg", "abc");

    await run("ensure", undefined, fakeProber({ "both.jpg": JPEG_IMAGE }), fakeGenerator());
    policiesRepo.delete(dropId);

    const stats = await run(
      "state",
      undefined,
      fakeProber({ "both.jpg": JPEG_IMAGE }),
      fakeGenerator(),
    );
    expect(stats).toMatchObject({ upToDate: 1, toGenerate: 0, toRegenerate: 0, toDelete: 1 });

    const cleanup = await run(
      "cleanup",
      undefined,
      fakeProber({ "both.jpg": JPEG_IMAGE }),
      fakeGenerator(),
    );
    expect(cleanup).toMatchObject({ toDelete: 1 });
    expect(fs.existsSync(path.join(root, `_thumbnail/both.jpg.${IMAGE_PARAMS}.abc.jpg`))).toBe(
      true,
    ); // "keep" survives
    expect(
      fs.existsSync(
        path.join(root, "_thumbnail/both.jpg.p2-drop-iw100-ih100-fmtimage_jpeg-q80.abc.jpg"),
      ),
    ).toBe(false); // "drop"'s own output is swept
  });

  it("reports missingCacheEntry without blocking the rest of the run", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("uncached.jpg");
    writeFile("normal.jpg");
    seedCache("normal.jpg", "abc");

    const prober = fakeProber({ "uncached.jpg": JPEG_IMAGE, "normal.jpg": JPEG_IMAGE });
    const stats = await run("state", undefined, prober, fakeGenerator());

    expect(stats).toMatchObject({ missingCacheEntry: 1, toGenerate: 1 });
  });

  it("reports stubbedOriginal for a stub with no existing thumbnail, never probing it (no real bytes to probe)", async () => {
    createGeneratePolicy("*.jpg");
    writeStub("stubbed-new.jpg", "abc");
    seedCache("stubbed-new.jpg", "abc");

    // A fakeProber keyed by string would happily "succeed" for this path
    // even though no real file exists on disk -- deliberately NOT
    // registering an entry for it here, so the test would fail loudly
    // (an unhandled fake-prober lookup) if classifyStub ever probed a
    // stub, instead of silently passing for the wrong reason.
    const prober = fakeProber({});
    const stats = await run("state", undefined, prober, fakeGenerator());

    expect(stats).toMatchObject({ stubbedOriginal: 1, stubbedPreserved: 0, toGenerate: 0 });
    expect(stats.staleStubPreviews).toEqual([]);
    expect(prober.detectMedia).not.toHaveBeenCalled();
  });

  it("reports stubbedPreserved for a stub whose existing thumbnail's hash matches its own cache.db hash, never probing it", async () => {
    createGeneratePolicy("*.jpg");
    writeStub("stubbed-current.jpg", "def");
    seedCache("stubbed-current.jpg", "def");
    writeFile(`_thumbnail/stubbed-current.jpg.${IMAGE_PARAMS}.def.jpg`);

    const prober = fakeProber({});
    const stats = await run("state", undefined, prober, fakeGenerator());

    expect(stats).toMatchObject({ stubbedPreserved: 1, stubbedOriginal: 0, upToDate: 0 });
    expect(stats.staleStubPreviews).toEqual([]);
    expect(prober.detectMedia).not.toHaveBeenCalled();
    // Never deleted, even under cleanup -- a preserved preview is exactly
    // the thing this fix protects.
    const cleanupStats = await run("cleanup", undefined, fakeProber({}), fakeGenerator());
    expect(cleanupStats).toMatchObject({ stubbedPreserved: 1, toDelete: 0 });
    expect(
      fs.existsSync(path.join(root, `_thumbnail/stubbed-current.jpg.${IMAGE_PARAMS}.def.jpg`)),
    ).toBe(true);
  });

  it("reports a stale stub preview when the stub's current hash doesn't match its existing thumbnail, and only deletes it under cleanup with --delete-stale-stub-previews", async () => {
    createGeneratePolicy("*.jpg");
    // The stub's own cache.db hash ("newhash") no longer matches the
    // thumbnail generated back when the file was still real ("oldhash") --
    // it was edited, then stubified, before a sync ever regenerated it.
    writeStub("stale.jpg", "newhash");
    seedCache("stale.jpg", "newhash");
    writeFile(`_thumbnail/stale.jpg.${IMAGE_PARAMS}.oldhash.jpg`);

    const prober = fakeProber({});
    const stateStats = await run("state", undefined, prober, fakeGenerator());
    expect(stateStats).toMatchObject({ stubbedOriginal: 0, stubbedPreserved: 0 });
    expect(stateStats.staleStubPreviews).toEqual([
      { path: "stale.jpg", thumbnailPath: `_thumbnail/stale.jpg.${IMAGE_PARAMS}.oldhash.jpg` },
    ]);
    expect(prober.detectMedia).not.toHaveBeenCalled();

    const cleanupNoFlag = await run("cleanup", undefined, fakeProber({}), fakeGenerator());
    expect(cleanupNoFlag.staleStubPreviews).toHaveLength(1);
    expect(fs.existsSync(path.join(root, `_thumbnail/stale.jpg.${IMAGE_PARAMS}.oldhash.jpg`))).toBe(
      true,
    );

    const cleanupWithFlag = await run("cleanup", undefined, fakeProber({}), fakeGenerator(), true);
    expect(cleanupWithFlag.staleStubPreviews).toHaveLength(1);
    expect(fs.existsSync(path.join(root, `_thumbnail/stale.jpg.${IMAGE_PARAMS}.oldhash.jpg`))).toBe(
      false,
    );
  });

  it("sweeps an orphaned thumbnail whose original no longer exists on disk", async () => {
    createGeneratePolicy("*.jpg");
    // original "gone.jpg" was never created / already deleted
    writeFile(`_thumbnail/gone.jpg.${IMAGE_PARAMS}.anyhash.jpg`);

    const stats = await run("state", undefined, fakeProber({}), fakeGenerator());
    expect(stats).toMatchObject({ toDelete: 1 });

    const cleanupStats = await run("cleanup", undefined, fakeProber({}), fakeGenerator());
    expect(cleanupStats).toMatchObject({ toDelete: 1 });
    expect(fs.existsSync(path.join(root, `_thumbnail/gone.jpg.${IMAGE_PARAMS}.anyhash.jpg`))).toBe(
      false,
    );
  });

  it("--glob scopes which candidates are probed at all, both by directory pruning and by full-pattern matching", async () => {
    createGeneratePolicy("**/*.jpg");
    writeFile("InScope/direct.jpg");
    writeFile("InScope/sub/nested.jpg");
    writeFile("OutOfScope/other.jpg");
    seedCache("InScope/direct.jpg", "a");
    seedCache("InScope/sub/nested.jpg", "b");
    seedCache("OutOfScope/other.jpg", "c");

    const prober = fakeProber({
      "InScope/direct.jpg": JPEG_IMAGE,
      "InScope/sub/nested.jpg": JPEG_IMAGE,
      "OutOfScope/other.jpg": JPEG_IMAGE,
    });
    const stats = await run("state", "InScope/*.jpg", prober, fakeGenerator());

    expect(stats).toMatchObject({ toGenerate: 1 }); // only InScope/direct.jpg
    const probedPaths = vi
      .mocked(prober.detectMedia)
      .mock.calls.map(([absolutePath]) => path.relative(root, absolutePath));
    expect(probedPaths).toEqual(["InScope/direct.jpg"]);
  });

  it("tallies a per-file generation failure under errors without aborting the run", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("bad.jpg");
    writeFile("good.jpg");
    seedCache("bad.jpg", "a");
    seedCache("good.jpg", "b");

    const prober = fakeProber({ "bad.jpg": JPEG_IMAGE, "good.jpg": JPEG_IMAGE });
    const generator = fakeGenerator(new Set([path.join(root, "bad.jpg")]));
    const stats = await run("ensure", undefined, prober, generator);

    expect(stats.errors).toBe(1);
    expect(stats.toGenerate).toBe(2);
    expect(generator.imageCalls).toHaveLength(1);
    // The surviving call is identified by its source: the staging path it
    // writes through is synthesized and names nothing.
    expect(generator.imageCalls[0]!.sourcePath).toBe(path.join(root, "good.jpg"));
    expect(fs.existsSync(path.join(root, `_thumbnail/good.jpg.${IMAGE_PARAMS}.b.jpg`))).toBe(true);
    // Named, not merely counted -- the per-file warning explaining this
    // goes to fd 3 while a progress bar owns stderr, so the count alone
    // leaves the caller with no way to know *which* file failed or why.
    expect(stats.failures).toEqual([
      { path: "bad.jpg", reason: expect.stringContaining("simulated failure") as string },
    ]);
  });

  /**
   * Discarding the staged file must never replace the failure that caused
   * it to be discarded. `force: true` swallows ENOENT but not ENAMETOOLONG
   * or EACCES, and a throw from the cleanup substitutes a plain Error for
   * the `ThumbnailGenerationError` that marks a failure as *per-file* --
   * which escalated one unwritable thumbnail into an aborted run that
   * printed no summary and named no path.
   */
  it("stays non-fatal when discarding the staged file itself fails", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("bad.jpg");
    writeFile("good.jpg");
    seedCache("bad.jpg", "a");
    seedCache("good.jpg", "b");

    const generator = fakeGenerator(new Set([path.join(root, "bad.jpg")]));
    const realRmSync = fs.rmSync;
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (typeof target === "string" && path.basename(target).startsWith(".sync1-tmp-")) {
        throw Object.assign(new Error("ENAMETOOLONG: name too long"), { code: "ENAMETOOLONG" });
      }
      return realRmSync(target, options);
    });

    try {
      const stats = await run(
        "ensure",
        undefined,
        fakeProber({ "bad.jpg": JPEG_IMAGE, "good.jpg": JPEG_IMAGE }),
        generator,
      );

      // The run completed: both sources were decided, the healthy one was
      // published, and the sick one was tallied rather than thrown.
      expect(stats.errors).toBe(1);
      expect(stats.toGenerate).toBe(2);
      expect(stats.failures).toHaveLength(1);
      expect(stats.failures[0]!.path).toBe("bad.jpg");
      expect(fs.existsSync(path.join(root, `_thumbnail/good.jpg.${IMAGE_PARAMS}.b.jpg`))).toBe(
        true,
      );
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("starts generation before discovery finalizes and advances once per resolved source", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("a.jpg");
    writeFile("b.jpg");
    seedCache("a.jpg", "hasha");
    seedCache("b.jpg", "hashb");

    const prober = fakeProber({ "a.jpg": JPEG_IMAGE, "b.jpg": JPEG_IMAGE });

    let resolveA: (() => void) | undefined;
    let resolveB: (() => void) | undefined;
    const generator: ThumbnailGenerator = {
      generateImageThumbnail: (input) =>
        new Promise<void>((resolve) => {
          const finish = () => {
            fs.mkdirSync(path.dirname(input.destPath), { recursive: true });
            fs.writeFileSync(input.destPath, "thumb");
            resolve();
          };
          if (input.sourcePath.endsWith("a.jpg")) resolveA = finish;
          else resolveB = finish;
        }),
      generateVideoMosaic: async () => {},
      generateVideoPreview: async () => {},
    };

    const updates: { discovered: number; completed: number; final: boolean }[] = [];
    const activities: { verb: string; path: string }[] = [];
    const pool = new PQueue({ concurrency: 4 });
    const statsPromise = scanThumbnails(
      root,
      "ensure",
      undefined,
      cacheRepo,
      policiesRepo.list(),
      ignorePoliciesRepo.listGlobs(),
      prober,
      generator,
      silentLogger,
      pool,
      8,
      false,
      () => {},
      (discovered, completed, final) => updates.push({ discovered, completed, final }),
      (verb, path) => activities.push({ verb, path }),
    );

    await vi.waitFor(() => {
      expect(resolveA).toBeDefined();
      expect(resolveB).toBeDefined();
    });
    expect(updates.some((update) => !update.final && update.completed === 0)).toBe(true);
    expect(activities).toContainEqual({ verb: "generating", path: "a.jpg" });
    expect(activities).toContainEqual({ verb: "generating", path: "b.jpg" });

    resolveA!();
    await vi.waitFor(() => {
      expect(updates.some((update) => update.completed === 1)).toBe(true);
    });
    expect(activities).toContainEqual({ verb: "generated", path: "a.jpg" });
    resolveB!();

    const stats = await statsPromise;
    expect(stats.toGenerate).toBe(2);
    expect(updates.at(-1)).toEqual({ discovered: 2, completed: 2, final: true });
    expect(activities.at(-1)).toEqual({ verb: "generated", path: "b.jpg" });
  });

  it("advances generation progress even when a per-file generation fails", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("bad.jpg");
    seedCache("bad.jpg", "a");

    const prober = fakeProber({ "bad.jpg": JPEG_IMAGE });
    const generator = fakeGenerator(new Set([path.join(root, "bad.jpg")]));

    const updates: { discovered: number; completed: number; final: boolean }[] = [];
    const pool = new PQueue({ concurrency: 4 });
    const stats = await scanThumbnails(
      root,
      "ensure",
      undefined,
      cacheRepo,
      policiesRepo.list(),
      ignorePoliciesRepo.listGlobs(),
      prober,
      generator,
      silentLogger,
      pool,
      8,
      false,
      () => {},
      (discovered, completed, final) => updates.push({ discovered, completed, final }),
    );

    expect(stats.errors).toBe(1);
    expect(updates.at(-1)).toEqual({ discovered: 1, completed: 1, final: true });
  });

  it("publishes an approximate work total, then finalizes on observed work", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("a.jpg");
    writeFile("b.jpg");
    writeFile("c.txt");
    seedCache("a.jpg", "hasha");
    seedCache("b.jpg", "hashb");

    const prober = fakeProber({ "a.jpg": JPEG_IMAGE, "b.jpg": JPEG_IMAGE });
    const estimates: number[] = [];
    const updates: { discovered: number; completed: number; final: boolean }[] = [];
    const pool = new PQueue({ concurrency: 4 });
    await scanThumbnails(
      root,
      "state",
      undefined,
      cacheRepo,
      policiesRepo.list(),
      ignorePoliciesRepo.listGlobs(),
      prober,
      fakeGenerator(),
      silentLogger,
      pool,
      8,
      false,
      (total) => estimates.push(total),
      (discovered, completed, final) => updates.push({ discovered, completed, final }),
    );

    expect(estimates.at(-1)).toBe(2);
    expect(updates.at(-1)).toEqual({ discovered: 2, completed: 2, final: true });
    expect(updates.slice(0, -1).every((update) => !update.final)).toBe(true);
  });

  it("reports progress and processed activity for state without generating", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("new.jpg");
    seedCache("new.jpg", "abc");

    const prober = fakeProber({ "new.jpg": JPEG_IMAGE });
    const updates: { discovered: number; completed: number; final: boolean }[] = [];
    const activities: { verb: string; path: string }[] = [];
    const pool = new PQueue({ concurrency: 4 });
    await scanThumbnails(
      root,
      "state",
      undefined,
      cacheRepo,
      policiesRepo.list(),
      ignorePoliciesRepo.listGlobs(),
      prober,
      fakeGenerator(),
      silentLogger,
      pool,
      8,
      false,
      () => {},
      (discovered, completed, final) => updates.push({ discovered, completed, final }),
      (verb, path) => activities.push({ verb, path }),
    );

    expect(updates.at(-1)).toEqual({ discovered: 1, completed: 1, final: true });
    expect(activities).toContainEqual({ verb: "processing", path: "new.jpg" });
    expect(activities.at(-1)).toEqual({ verb: "processed", path: "new.jpg" });
  });

  it("generates a video mosaic via generateVideoMosaic, sized from the matching policy's tile settings", async () => {
    policiesRepo.create({
      name: "vid",
      glob: "*.mp4",
      action: "generate",
      mediaType: "video",
      outputType: "mosaic",
      mimeTypes: ["video/*"],
      tileRowCount: 3,
      tileColumnCount: 3,
      shorterSide: 48,
      outputMime: "image/jpeg",
      jpegQuality: 80,
    });
    writeFile("clip.mp4");
    seedCache("clip.mp4", "vid1");

    const prober = fakeProber({
      "clip.mp4": {
        kind: "video",
        mimeType: "video/mp4",
        width: 1920,
        height: 1080,
        durationSeconds: 10,
      },
    });
    const generator = fakeGenerator();
    const stats = await run("ensure", undefined, prober, generator);

    expect(stats).toMatchObject({ toGenerate: 1 });
    expect(generator.videoCalls).toHaveLength(1);
    expect(fs.existsSync(path.join(root, `_thumbnail/clip.mp4.${VIDEO_PARAMS}.vid1.jpg`))).toBe(
      true,
    );
  });

  it("generates via generateVideoPreview for an 'output_type=preview' policy -- .gif extension, no jpegQuality in the params segment", async () => {
    policiesRepo.create({
      name: "gifpolicy",
      glob: "*.mp4",
      action: "generate",
      mediaType: "video",
      outputType: "preview",
      mimeTypes: ["video/*"],
      shorterSide: 32,
      frameCount: 6,
      frameDelayMs: 100,
      outputMime: "image/gif",
      gifMaxColors: 256,
      gifDither: "sierra2_4a",
    });
    writeFile("clip.mp4");
    seedCache("clip.mp4", "vid1");

    const media: ProbedMedia = {
      kind: "video",
      mimeType: "video/mp4",
      width: 1920,
      height: 1080,
      durationSeconds: 10,
    };
    const generator = fakeGenerator();
    const stats = await run("ensure", undefined, fakeProber({ "clip.mp4": media }), generator);

    expect(stats).toMatchObject({ toGenerate: 1 });
    expect(generator.videoCalls).toHaveLength(0); // mosaic generator untouched
    expect(generator.gifCalls).toHaveLength(1);
    expect(
      fs.existsSync(
        path.join(
          root,
          "_thumbnail/clip.mp4.p2-gifpolicy-ss32-fc6-fd100-fmtimage_gif-mc256-dtsierra2_4a.vid1.gif",
        ),
      ),
    ).toBe(true);

    // Up to date on the next run -- the .gif extension round-trips through
    // parseThumbnailEntry/expectedThumbExtension correctly.
    const second = await run(
      "state",
      undefined,
      fakeProber({ "clip.mp4": media }),
      fakeGenerator(),
    );
    expect(second).toMatchObject({ upToDate: 1, toGenerate: 0 });
  });

  it("a mosaic policy and a gif policy both matching the same video each produce their own thumbnail", async () => {
    policiesRepo.create({
      name: "mosaicpolicy",
      glob: "*.mp4",
      action: "generate",
      mediaType: "video",
      outputType: "mosaic",
      mimeTypes: ["video/*"],
      tileRowCount: 2,
      tileColumnCount: 2,
      shorterSide: 32,
      outputMime: "image/jpeg",
      jpegQuality: 80,
    });
    policiesRepo.create({
      name: "gifpolicy",
      glob: "*.mp4",
      action: "generate",
      mediaType: "video",
      outputType: "preview",
      mimeTypes: ["video/*"],
      shorterSide: 32,
      frameCount: 4,
      frameDelayMs: 100,
      outputMime: "image/gif",
      gifMaxColors: 256,
      gifDither: "sierra2_4a",
    });
    writeFile("clip.mp4");
    seedCache("clip.mp4", "vid1");

    const media = {
      kind: "video" as const,
      mimeType: "video/mp4",
      width: 1920,
      height: 1080,
      durationSeconds: 10,
    };
    const generator = fakeGenerator();
    const stats = await run("ensure", undefined, fakeProber({ "clip.mp4": media }), generator);

    expect(stats).toMatchObject({ toGenerate: 2, toDelete: 0 });
    expect(generator.videoCalls).toHaveLength(1);
    expect(generator.gifCalls).toHaveLength(1);
    expect(
      fs.existsSync(
        path.join(
          root,
          "_thumbnail/clip.mp4.p2-mosaicpolicy-ss32-tr2-tc2-fmtimage_jpeg-q80.vid1.jpg",
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          root,
          "_thumbnail/clip.mp4.p2-gifpolicy-ss32-fc4-fd100-fmtimage_gif-mc256-dtsierra2_4a.vid1.gif",
        ),
      ),
    ).toBe(true);
  });

  it("generates via resize_shorter_side, scaling the source's shorter side to the configured target", async () => {
    policiesRepo.create({
      name: "short",
      glob: "*.jpg",
      action: "generate",
      mediaType: "image",
      resizingStrategy: "resize_shorter_side",
      mimeTypes: ["image/jpeg"],
      shorterSide: 100,
      outputMime: "image/jpeg",
      jpegQuality: 80,
    });
    writeFile("photo.jpg");
    seedCache("photo.jpg", "abc");

    // JPEG_IMAGE is 800x600 -- shorter side (600) scaled to 100 gives
    // scale 1/6, so width also scales to 800/6 = 133.33... -> 133.
    const generator = fakeGenerator();
    const stats = await run(
      "ensure",
      undefined,
      fakeProber({ "photo.jpg": JPEG_IMAGE }),
      generator,
    );

    expect(stats).toMatchObject({ toGenerate: 1 });
    expect(generator.imageCalls).toHaveLength(1);
    expect(generator.imageCalls[0]).toMatchObject({
      width: 133,
      height: 100,
    });
    expect(
      fs.existsSync(
        path.join(root, "_thumbnail/photo.jpg.p2-short-ss100-fmtimage_jpeg-q80.abc.jpg"),
      ),
    ).toBe(true);
  });

  it("the thumbnail's extension comes from the policy's output_mime alone, never the source's own extension/mime type -- a source ImageMagick can read but not write (e.g. CR2) is no longer special-cased", async () => {
    policiesRepo.create({
      name: "raw_to_webp",
      glob: "*.CR2",
      action: "generate",
      mediaType: "image",
      resizingStrategy: "fit_to_box",
      mimeTypes: ["image/x-canon-cr2"],
      imageWidth: 320,
      imageHeight: 240,
      outputMime: "image/webp",
      webpQuality: 80,
      webpLossless: false,
    });
    writeFile("photo.CR2");
    seedCache("photo.CR2", "rawhash");

    const prober = fakeProber({ "photo.CR2": CR2_IMAGE });
    const generator = fakeGenerator();
    const stats = await run("ensure", undefined, prober, generator);

    expect(stats).toMatchObject({ toGenerate: 1, errors: 0 });
    expect(generator.imageCalls).toHaveLength(1);
    expect(generator.imageCalls[0]!.destPath).toMatch(/\.webp$/);
    expect(generator.imageCalls[0]!.destPath).not.toMatch(/\.CR2$/i);
  });

  it("never probes a path that matches no policy glob at all", async () => {
    createGeneratePolicy("Photos/*.jpg");
    writeFile("Documents/report.jpg");

    const prober = fakeProber({ "Documents/report.jpg": JPEG_IMAGE });
    await run("state", undefined, prober, fakeGenerator());

    expect(prober.detectMedia).not.toHaveBeenCalled();
  });

  it("never probes a path matching an ignore policy, even though it also matches a thumbnail policy", async () => {
    createGeneratePolicy("*.jpg");
    ignorePoliciesRepo.create("private.jpg");
    writeFile("private.jpg");

    const prober = fakeProber({ "private.jpg": JPEG_IMAGE });
    const stats = await run("state", undefined, prober, fakeGenerator());

    expect(prober.detectMedia).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ toGenerate: 0, upToDate: 0, toDelete: 0 });
  });

  it("an ignore-matched path's existing thumbnail is swept as an ordinary orphan, not explicitly deleted", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("private.jpg");
    seedCache("private.jpg", "abc");
    writeFile(`_thumbnail/private.jpg.${IMAGE_PARAMS}.abc.jpg`);

    // Thumbnailed once before the ignore policy existed -- now-ignored, so
    // the next scan must never re-claim it, and its stale thumbnail must
    // fall through to the same unclaimed-orphan sweep any other orphan
    // does (no ignore-specific deletion path).
    ignorePoliciesRepo.create("private.jpg");

    const stats = await run("state", undefined, fakeProber({}), fakeGenerator());
    expect(stats).toMatchObject({ toDelete: 1, upToDate: 0 });
    expect(fs.existsSync(path.join(root, `_thumbnail/private.jpg.${IMAGE_PARAMS}.abc.jpg`))).toBe(
      true,
    ); // state never deletes

    const cleanupStats = await run("cleanup", undefined, fakeProber({}), fakeGenerator());
    expect(cleanupStats).toMatchObject({ toDelete: 1 });
    expect(fs.existsSync(path.join(root, `_thumbnail/private.jpg.${IMAGE_PARAMS}.abc.jpg`))).toBe(
      false,
    );
  });
});
