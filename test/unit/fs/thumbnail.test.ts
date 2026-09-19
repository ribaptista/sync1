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
import { scanThumbnails, type ThumbnailScanStats } from "../../../src/fs/thumbnail.js";
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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-thumbnail-test-"));
  stateDb = openStateDb(":memory:");
  cacheDb = openCacheDb(":memory:");
  cacheRepo = new CacheEntriesRepository(cacheDb);
  policiesRepo = new ThumbnailPoliciesRepository(stateDb);
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
  action: "generate",
  mediaType: "image",
  mimeTypes: ["image/jpeg"],
  priority: 0,
  imageWidth: 320,
  imageHeight: 240,
  jpegQuality: 80,
} satisfies Omit<Extract<ThumbnailPolicyCreateInput, { mediaType: "image" }>, "glob">;

function createGeneratePolicy(glob: string, overrides: Partial<typeof GENERATE_JPEG> = {}): number {
  return policiesRepo.create({ ...GENERATE_JPEG, glob, ...overrides });
}

function createSkipPolicy(glob: string, mimeTypes = ["image/jpeg"]): number {
  return policiesRepo.create({ glob, action: "skip", mimeTypes });
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
} {
  const imageCalls: { sourcePath: string; destPath: string; width: number; height: number }[] = [];
  const videoCalls: { sourcePath: string; destPath: string }[] = [];
  return {
    imageCalls,
    videoCalls,
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
    prober,
    generator,
    silentLogger,
    pool,
    8,
    deleteStaleStubPreviews,
  );
}

const JPEG_IMAGE: ProbedMedia = { kind: "image", mimeType: "image/jpeg", width: 800, height: 600 };

describe("scanThumbnails", () => {
  it("reports up-to-date when an existing thumbnail's hash matches cache.db's current hash", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("photo.jpg");
    seedCache("photo.jpg", "abc123");
    writeFile("_thumbnail/photo.jpg.abc123.jpg");

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
      destPath: path.join(root, "_thumbnail/new.jpg.def456.jpg"),
      width: 320,
      height: 240,
    });
    expect(fs.existsSync(path.join(root, "_thumbnail/new.jpg.def456.jpg"))).toBe(true);
  });

  it("reports toRegenerate for a stale existing thumbnail, and ensure deletes the old one before generating the new one", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("changed.jpg");
    seedCache("changed.jpg", "newhash");
    writeFile("_thumbnail/changed.jpg.oldhash.jpg");

    const prober = fakeProber({ "changed.jpg": JPEG_IMAGE });
    const generator = fakeGenerator();
    const stats = await run("ensure", undefined, prober, generator);

    expect(stats).toMatchObject({ toRegenerate: 1, upToDate: 0 });
    expect(fs.existsSync(path.join(root, "_thumbnail/changed.jpg.oldhash.jpg"))).toBe(false);
    expect(fs.existsSync(path.join(root, "_thumbnail/changed.jpg.newhash.jpg"))).toBe(true);
  });

  it("reports toDelete for a skip-matched original with an existing thumbnail, and only cleanup removes it", async () => {
    createSkipPolicy("private/**");
    writeFile("private/secret.jpg");
    seedCache("private/secret.jpg", "abc");
    writeFile("_thumbnail/secret.jpg.abc.jpg".replace("_thumbnail", "private/_thumbnail"));

    const prober = fakeProber({ "private/secret.jpg": JPEG_IMAGE });

    const ensureStats = await run("ensure", undefined, prober, fakeGenerator());
    expect(ensureStats).toMatchObject({ toDelete: 1 });
    expect(fs.existsSync(path.join(root, "private/_thumbnail/secret.jpg.abc.jpg"))).toBe(true); // ensure never touches bucket d

    const cleanupStats = await run("cleanup", undefined, prober, fakeGenerator());
    expect(cleanupStats).toMatchObject({ toDelete: 1 });
    expect(fs.existsSync(path.join(root, "private/_thumbnail/secret.jpg.abc.jpg"))).toBe(false);
  });

  it("skip beats generate even when the generate policy has the lowest priority", async () => {
    createGeneratePolicy("secret.jpg", { priority: 0 });
    createSkipPolicy("secret.jpg");
    writeFile("secret.jpg");
    seedCache("secret.jpg", "abc");

    const prober = fakeProber({ "secret.jpg": JPEG_IMAGE });
    const generator = fakeGenerator();
    const stats = await run("ensure", undefined, prober, generator);

    expect(stats).toMatchObject({ toGenerate: 0, toRegenerate: 0, upToDate: 0 });
    expect(generator.imageCalls).toHaveLength(0);
  });

  it("breaks a tie between two matching generate policies via priority (lower wins)", async () => {
    createGeneratePolicy("*.jpg", { priority: 5, imageWidth: 999, imageHeight: 999 });
    createGeneratePolicy("*.jpg", { priority: 1, imageWidth: 100, imageHeight: 100 });
    writeFile("tie.jpg");
    seedCache("tie.jpg", "abc");

    const prober = fakeProber({ "tie.jpg": JPEG_IMAGE });
    const generator = fakeGenerator();
    await run("ensure", undefined, prober, generator);

    expect(generator.imageCalls).toHaveLength(1);
    // JPEG_IMAGE is 800x600 (4:3) -- contain-fit into a 100x100 box yields 100x75, not 100x100.
    expect(generator.imageCalls[0]).toMatchObject({ width: 100, height: 75 });
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
    writeFile("_thumbnail/stubbed-current.jpg.def.jpg");

    const prober = fakeProber({});
    const stats = await run("state", undefined, prober, fakeGenerator());

    expect(stats).toMatchObject({ stubbedPreserved: 1, stubbedOriginal: 0, upToDate: 0 });
    expect(stats.staleStubPreviews).toEqual([]);
    expect(prober.detectMedia).not.toHaveBeenCalled();
    // Never deleted, even under cleanup -- a preserved preview is exactly
    // the thing this fix protects.
    const cleanupStats = await run("cleanup", undefined, fakeProber({}), fakeGenerator());
    expect(cleanupStats).toMatchObject({ stubbedPreserved: 1, toDelete: 0 });
    expect(fs.existsSync(path.join(root, "_thumbnail/stubbed-current.jpg.def.jpg"))).toBe(true);
  });

  it("reports a stale stub preview when the stub's current hash doesn't match its existing thumbnail, and only deletes it under cleanup with --delete-stale-stub-previews", async () => {
    createGeneratePolicy("*.jpg");
    // The stub's own cache.db hash ("newhash") no longer matches the
    // thumbnail generated back when the file was still real ("oldhash") --
    // it was edited, then stubified, before a sync ever regenerated it.
    writeStub("stale.jpg", "newhash");
    seedCache("stale.jpg", "newhash");
    writeFile("_thumbnail/stale.jpg.oldhash.jpg");

    const prober = fakeProber({});
    const stateStats = await run("state", undefined, prober, fakeGenerator());
    expect(stateStats).toMatchObject({ stubbedOriginal: 0, stubbedPreserved: 0 });
    expect(stateStats.staleStubPreviews).toEqual([
      { path: "stale.jpg", thumbnailPath: "_thumbnail/stale.jpg.oldhash.jpg" },
    ]);
    expect(prober.detectMedia).not.toHaveBeenCalled();

    const cleanupNoFlag = await run("cleanup", undefined, fakeProber({}), fakeGenerator());
    expect(cleanupNoFlag.staleStubPreviews).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "_thumbnail/stale.jpg.oldhash.jpg"))).toBe(true);

    const cleanupWithFlag = await run("cleanup", undefined, fakeProber({}), fakeGenerator(), true);
    expect(cleanupWithFlag.staleStubPreviews).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "_thumbnail/stale.jpg.oldhash.jpg"))).toBe(false);
  });

  it("sweeps an orphaned thumbnail whose original no longer exists on disk", async () => {
    createGeneratePolicy("*.jpg");
    writeFile("_thumbnail/gone.jpg.anyhash.jpg"); // original "gone.jpg" was never created / already deleted

    const stats = await run("state", undefined, fakeProber({}), fakeGenerator());
    expect(stats).toMatchObject({ toDelete: 1 });

    const cleanupStats = await run("cleanup", undefined, fakeProber({}), fakeGenerator());
    expect(cleanupStats).toMatchObject({ toDelete: 1 });
    expect(fs.existsSync(path.join(root, "_thumbnail/gone.jpg.anyhash.jpg"))).toBe(false);
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
      destPath: path.join(root, "_thumbnail/good.jpg.b.jpg"),
    });
  });

  it("generates a video mosaic via generateVideoMosaic, sized from the matching policy's tile settings", async () => {
    policiesRepo.create({
      glob: "*.mp4",
      action: "generate",
      mediaType: "video",
      mimeTypes: ["video/*"],
      priority: 0,
      tileRowCount: 3,
      tileColumnCount: 3,
      tileSize: 48,
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
      destPath: path.join(root, "_thumbnail/clip.mp4.vid1.jpg"),
    });
  });

  it("never probes a path that matches no policy glob at all", async () => {
    createGeneratePolicy("Photos/*.jpg");
    writeFile("Documents/report.jpg");

    const prober = fakeProber({ "Documents/report.jpg": JPEG_IMAGE });
    await run("state", undefined, prober, fakeGenerator());

    expect(prober.detectMedia).not.toHaveBeenCalled();
  });
});
