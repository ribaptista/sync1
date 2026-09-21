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
    expect(generator.imageCalls[0]).toMatchObject({
      destPath: path.join(root, `_thumbnail/new.jpg.${IMAGE_PARAMS}.def456.jpg`),
      width: 320,
      height: 240,
    });
    expect(fs.existsSync(path.join(root, `_thumbnail/new.jpg.${IMAGE_PARAMS}.def456.jpg`))).toBe(
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
    const stats = await run("ensure", undefined, prober, generator);

    expect(stats).toMatchObject({ toGenerate: 2, toRegenerate: 0, upToDate: 0, toDelete: 0 });
    expect(generator.imageCalls).toHaveLength(2);
    const byWidth = new Map(generator.imageCalls.map((c) => [c.width, c]));
    // JPEG_IMAGE is 800x600 (4:3) -- contain-fit into each policy's own box.
    expect(byWidth.get(999)).toMatchObject({
      height: 749,
      destPath: path.join(root, "_thumbnail/both.jpg.p2-big-iw999-ih999-fmtimage_jpeg-q80.abc.jpg"),
    });
    expect(byWidth.get(100)).toMatchObject({
      height: 75,
      destPath: path.join(
        root,
        "_thumbnail/both.jpg.p2-small-iw100-ih100-fmtimage_jpeg-q80.abc.jpg",
      ),
    });

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
    expect(generator.imageCalls[0]).toMatchObject({
      destPath: path.join(root, `_thumbnail/good.jpg.${IMAGE_PARAMS}.b.jpg`),
    });
  });

  it("opens the generation phase on its exact, final total, and only advances generated as each resolves", async () => {
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

    const updates: { total: number; generated: number }[] = [];
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
      undefined,
      (total, generated) => updates.push({ total, generated }),
    );

    // The denominator is right from the very first report -- not grown to
    // 2 as the second job is dispatched. Every candidate is decided before
    // any of them is dispatched, so there is nothing left to discover.
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));
    expect(updates[0]).toEqual({ total: 2, generated: 0 });

    await vi.waitFor(() => {
      expect(resolveA).toBeDefined();
      expect(resolveB).toBeDefined();
    });
    // Both dispatched before either generation call's own promise ever
    // settles -- generated stays 0 the whole time.
    expect(updates.every((u) => u.generated === 0)).toBe(true);
    expect(updates.every((u) => u.total === 2)).toBe(true);

    resolveA!();
    await vi.waitFor(() => {
      expect(updates.some((u) => u.generated === 1)).toBe(true);
    });
    resolveB!();

    const stats = await statsPromise;
    expect(stats.toGenerate).toBe(2);
    expect(updates.at(-1)).toEqual({ total: 2, generated: 2 });
  });

  it("advances generation progress even when a per-file generation fails", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("bad.jpg");
    seedCache("bad.jpg", "a");

    const prober = fakeProber({ "bad.jpg": JPEG_IMAGE });
    const generator = fakeGenerator(new Set([path.join(root, "bad.jpg")]));

    const updates: { total: number; generated: number }[] = [];
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
      undefined,
      (total, generated) => updates.push({ total, generated }),
    );

    expect(stats.errors).toBe(1);
    expect(updates.at(-1)).toEqual({ total: 1, generated: 1 });
  });

  it("reports the walk's entry total ahead of the walk, then finalizes on the real count", async () => {
    // A denominator for the scan bar that isn't just its own numerator:
    // three files plus the root's one subdirectory-free walk, counted by
    // the concurrent pass before the probing walk has finished.
    createGeneratePolicy("*.jpg");
    writeFile("a.jpg");
    writeFile("b.jpg");
    writeFile("c.txt");
    seedCache("a.jpg", "hasha");
    seedCache("b.jpg", "hashb");

    const prober = fakeProber({ "a.jpg": JPEG_IMAGE, "b.jpg": JPEG_IMAGE });
    const scanned: number[] = [];
    const totals: { total: number; final: boolean }[] = [];
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
      (n) => scanned.push(n),
      undefined,
      (total, final) => totals.push({ total, final }),
    );

    // The last word is the real walk's own count, marked final -- and it
    // agrees with what the walk actually reported as its numerator.
    expect(totals.at(-1)).toEqual({ total: scanned.at(-1), final: true });
    expect(scanned.at(-1)).toBe(3);
    // Nothing published a total before that one claimed to be final.
    expect(totals.slice(0, -1).every((t) => !t.final)).toBe(true);
  });

  it("never fires onGenerationProgress for state or cleanup, which never generate anything", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("new.jpg");
    seedCache("new.jpg", "abc");

    const prober = fakeProber({ "new.jpg": JPEG_IMAGE });
    const updates: unknown[] = [];
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
      undefined,
      (total, generated) => updates.push({ total, generated }),
    );

    expect(updates).toEqual([]);
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
    expect(generator.videoCalls[0]).toMatchObject({
      destPath: path.join(root, `_thumbnail/clip.mp4.${VIDEO_PARAMS}.vid1.jpg`),
    });
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
    expect(generator.gifCalls[0]).toMatchObject({
      destPath: path.join(
        root,
        "_thumbnail/clip.mp4.p2-gifpolicy-ss32-fc6-fd100-fmtimage_gif-mc256-dtsierra2_4a.vid1.gif",
      ),
    });

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
      destPath: path.join(root, "_thumbnail/photo.jpg.p2-short-ss100-fmtimage_jpeg-q80.abc.jpg"),
    });
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
