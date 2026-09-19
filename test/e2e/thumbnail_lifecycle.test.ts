import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";

const PASSWORD = "correct horse battery staple";
const FIXTURES_DIR = path.resolve("test/fixtures/media");

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-thumbnail-lifecycle-"));
}

interface ThumbnailStatsJson {
  ok: boolean;
  up_to_date: number;
  to_generate: number;
  to_regenerate: number;
  to_delete: number;
  missing_cache_entry: number;
  stubbed_original: number;
  stubbed_preserved: number;
  stale_stub_previews: Array<{ path: string; thumbnail_path: string }>;
  errors: number;
}

function readCacheEntry(root: string, relativePath: string): { hash: string | null } | undefined {
  const db = new Database(path.join(root, ".sync1", "cache.db"), { readonly: true });
  const row = db.prepare("SELECT hash FROM entries WHERE path = ?").get(relativePath) as
    { hash: string | null } | undefined;
  db.close();
  return row;
}

const IMAGE_GENERATE_FLAGS = [
  "--media-type",
  "image",
  "--image-width",
  "16",
  "--image-height",
  "16",
  "--jpeg-quality",
  "80",
];

const VIDEO_GENERATE_FLAGS = [
  "--media-type",
  "video",
  "--tile-rows",
  "2",
  "--tile-columns",
  "2",
  "--tile-size",
  "16",
  "--jpeg-quality",
  "80",
];

describe("thumbnail lifecycle (end to end)", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("generates image and video thumbnails, reacts to a generate->skip policy edit, and lets a plain sync pick up the survivor with no special-casing", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();

    await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        root,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );

    // Mixed tree: a top-level image, a video, and an image under a
    // subfolder that a dedicated skip policy will exclude.
    fs.copyFileSync(path.join(FIXTURES_DIR, "tiny.jpg"), path.join(root, "photo.jpg"));
    fs.copyFileSync(path.join(FIXTURES_DIR, "tiny.mp4"), path.join(root, "clip.mp4"));
    fs.mkdirSync(path.join(root, "private"));
    fs.copyFileSync(path.join(FIXTURES_DIR, "tiny.jpg"), path.join(root, "private", "secret.jpg"));

    const imagePolicy = await runCli(
      [
        "thumbnail_policy",
        "create",
        "**/*.jpg",
        "generate",
        "--root",
        root,
        "--mime-types",
        "image/jpeg",
        ...IMAGE_GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(imagePolicy.exitCode).toBe(0);
    const imagePolicyId = (JSON.parse(imagePolicy.stdout) as { id: number }).id;

    const videoPolicy = await runCli(
      [
        "thumbnail_policy",
        "create",
        "**/*.mp4",
        "generate",
        "--root",
        root,
        "--mime-types",
        "video/*",
        ...VIDEO_GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(videoPolicy.exitCode).toBe(0);

    const skipPolicy = await runCli(
      [
        "thumbnail_policy",
        "create",
        "private/**",
        "skip",
        "--root",
        root,
        "--mime-types",
        "image/jpeg",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(skipPolicy.exitCode).toBe(0);

    await runCli(["update_cache", "--root", root, "--json"]);

    // state: the top-level image and the video need generating; the
    // skip-matched private/secret.jpg contributes nothing (no existing
    // thumbnail yet to flag as extra).
    const state1 = await runCli(["thumbnail", "state", "--root", root, "--json"]);
    expect(JSON.parse(state1.stdout) as ThumbnailStatsJson).toMatchObject({
      to_generate: 2,
      to_delete: 0,
    });

    const ensure1 = await runCli(["thumbnail", "ensure", "--root", root, "--json"]);
    const ensure1Parsed = JSON.parse(ensure1.stdout) as ThumbnailStatsJson;
    expect(ensure1Parsed).toMatchObject({ to_generate: 2, errors: 0 });

    // photo.jpg and clip.mp4 are both root-level, so both thumbnails land
    // in the same root _thumbnail/ dir.
    const rootThumbs = fs.readdirSync(path.join(root, "_thumbnail"));
    expect(rootThumbs).toHaveLength(2);
    expect(rootThumbs.some((f) => /^photo\.jpg\.p1-iw16-ih16-q80\.[0-9a-f]+\.jpg$/.test(f))).toBe(
      true,
    );
    expect(rootThumbs.some((f) => /^clip\.mp4\.p1-tr2-tc2-ts16-q80\.[0-9a-f]+\.jpg$/.test(f))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(root, "private", "_thumbnail"))).toBe(false);

    const cleanup1 = await runCli(["thumbnail", "cleanup", "--root", root, "--json"]);
    expect(JSON.parse(cleanup1.stdout) as ThumbnailStatsJson).toMatchObject({ to_delete: 0 });
    expect(fs.readdirSync(path.join(root, "_thumbnail"))).toHaveLength(2); // both still present

    // Flip the image policy from generate to skip -- the existing photo.jpg
    // thumbnail should now be flagged for deletion, while the video's
    // thumbnail (untouched policy) remains up to date.
    const editToSkip = await runCli(
      [
        "thumbnail_policy",
        "edit",
        String(imagePolicyId),
        "--action",
        "skip",
        "--root",
        root,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(editToSkip.exitCode).toBe(0);

    const state2 = await runCli(["thumbnail", "state", "--root", root, "--json"]);
    expect(JSON.parse(state2.stdout) as ThumbnailStatsJson).toMatchObject({
      to_delete: 1,
      up_to_date: 1, // the video thumbnail
    });

    const cleanup2 = await runCli(["thumbnail", "cleanup", "--root", root, "--json"]);
    expect(JSON.parse(cleanup2.stdout) as ThumbnailStatsJson).toMatchObject({ to_delete: 1 });

    const remainingThumbs = fs.readdirSync(path.join(root, "_thumbnail"));
    expect(remainingThumbs).toHaveLength(1);
    expect(remainingThumbs[0]).toMatch(/^clip\.mp4\.p1-tr2-tc2-ts16-q80\.[0-9a-f]+\.jpg$/);

    // A plain update_cache + sync picks up the surviving thumbnail as
    // ordinary tracked content -- no special-casing anywhere in that path.
    const updateCache2 = await runCli(["update_cache", "--root", root, "--json"]);
    expect(updateCache2.exitCode).toBe(0);
    const thumbnailRelativePath = `_thumbnail/${remainingThumbs[0]}`;
    expect(readCacheEntry(root, thumbnailRelativePath)?.hash).toEqual(expect.any(String));

    const sync = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(sync.exitCode).toBe(0);

    const inspect = await runCli(["inspect", thumbnailRelativePath, "--root", root, "--json"]);
    expect(inspect.exitCode).toBe(0);
    const inspectParsed = JSON.parse(
      inspect.stdout
        .trim()
        .split("\n")
        .find((line) => line.length > 0) ?? "{}",
    ) as { cache: { hash: string | null } | null; state: { hash: string | null } | null };
    expect(inspectParsed.state?.hash).toEqual(expect.any(String));

    fs.rmSync(root, { recursive: true, force: true });
  }, 60000);

  it("generates a .jpg thumbnail from a Canon CR2 raw original through the real CLI, never a .CR2 destination", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();

    await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        root,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );

    fs.copyFileSync(path.join(FIXTURES_DIR, "tiny.CR2"), path.join(root, "photo.CR2"));

    const policy = await runCli(
      [
        "thumbnail_policy",
        "create",
        "*.CR2",
        "generate",
        "--root",
        root,
        "--mime-types",
        "image/x-canon-cr2",
        ...IMAGE_GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(policy.exitCode).toBe(0);

    await runCli(["update_cache", "--root", root, "--json"]);
    const ensure = await runCli(["thumbnail", "ensure", "--root", root, "--json"]);
    expect(JSON.parse(ensure.stdout) as ThumbnailStatsJson).toMatchObject({
      to_generate: 1,
      errors: 0,
    });

    const thumbs = fs.readdirSync(path.join(root, "_thumbnail"));
    expect(thumbs).toHaveLength(1);
    // CR2 is write-incapable in ImageMagick -- forced to .jpg regardless
    // of the original's own .CR2 extension, per RAW_IMAGE_MIME_TYPES.
    expect(thumbs[0]).toMatch(/^photo\.CR2\.p1-iw16-ih16-q80\.[0-9a-f]+\.jpg$/);

    fs.rmSync(root, { recursive: true, force: true });
  }, 60000);

  it("preserves a stubbed original's up-to-date thumbnail across stubify, reporting it as stubbed_preserved", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();

    await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        root,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );

    fs.copyFileSync(path.join(FIXTURES_DIR, "tiny.jpg"), path.join(root, "photo.jpg"));

    await runCli(
      [
        "thumbnail_policy",
        "create",
        "**/*.jpg",
        "generate",
        "--root",
        root,
        "--mime-types",
        "image/jpeg",
        ...IMAGE_GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );

    await runCli(["update_cache", "--root", root, "--json"]);
    const ensure = await runCli(["thumbnail", "ensure", "--root", root, "--json"]);
    expect(JSON.parse(ensure.stdout) as ThumbnailStatsJson).toMatchObject({ to_generate: 1 });
    const thumbFile = fs.readdirSync(path.join(root, "_thumbnail"))[0]!;
    const thumbPath = path.join(root, "_thumbnail", thumbFile);
    expect(fs.existsSync(thumbPath)).toBe(true);

    // Fully commit, then replace the real file with a stub -- the whole
    // point of a thumbnail is previewing content that's deliberately not
    // kept materialized locally, so its thumbnail must survive this.
    const sync = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(sync.exitCode).toBe(0);
    const stubify = await runCli(["stubify", "photo.jpg", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(stubify.exitCode).toBe(0);
    expect(fs.existsSync(path.join(root, "photo.jpg"))).toBe(false);
    expect(fs.existsSync(path.join(root, "photo.jpg.stub"))).toBe(true);

    const stateAfterStubify = await runCli(["thumbnail", "state", "--root", root, "--json"]);
    expect(JSON.parse(stateAfterStubify.stdout) as ThumbnailStatsJson).toMatchObject({
      stubbed_preserved: 1,
      stubbed_original: 0,
      to_delete: 0,
    });
    expect(fs.existsSync(thumbPath)).toBe(true);

    // cleanup never deletes a preserved preview either.
    const cleanup = await runCli(["thumbnail", "cleanup", "--root", root, "--json"]);
    expect(JSON.parse(cleanup.stdout) as ThumbnailStatsJson).toMatchObject({
      stubbed_preserved: 1,
      to_delete: 0,
    });
    expect(fs.existsSync(thumbPath)).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  }, 60000);

  it("flags a stubbed original's thumbnail as a stale stub preview once the stub's content changes, and only deletes it via cleanup --delete-stale-stub-previews", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();

    await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        root,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );

    fs.copyFileSync(path.join(FIXTURES_DIR, "tiny.jpg"), path.join(root, "photo.jpg"));

    await runCli(
      [
        "thumbnail_policy",
        "create",
        "**/*.jpg",
        "generate",
        "--root",
        root,
        "--mime-types",
        "image/jpeg",
        ...IMAGE_GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );

    await runCli(["update_cache", "--root", root, "--json"]);
    const ensure = await runCli(["thumbnail", "ensure", "--root", root, "--json"]);
    expect(JSON.parse(ensure.stdout) as ThumbnailStatsJson).toMatchObject({ to_generate: 1 });
    const thumbFile = fs.readdirSync(path.join(root, "_thumbnail"))[0]!;
    const thumbPath = path.join(root, "_thumbnail", thumbFile);

    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    // Edit the file's content *after* its thumbnail was generated, commit
    // that edit too, then stubify -- the stub's own hash now disagrees
    // with the thumbnail filename's embedded hash, with no real bytes left
    // locally to regenerate from.
    fs.writeFileSync(path.join(root, "photo.jpg"), "a completely different file, not a real jpeg");
    const syncEdit = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(syncEdit.exitCode).toBe(0);
    const stubify = await runCli(["stubify", "photo.jpg", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(stubify.exitCode).toBe(0);
    expect(fs.existsSync(path.join(root, "photo.jpg"))).toBe(false);

    const state = await runCli(["thumbnail", "state", "--root", root, "--json"]);
    const stateParsed = JSON.parse(state.stdout) as ThumbnailStatsJson;
    expect(stateParsed).toMatchObject({ ok: false, stubbed_preserved: 0, stubbed_original: 0 });
    expect(stateParsed.stale_stub_previews).toEqual([
      { path: "photo.jpg", thumbnail_path: `_thumbnail/${thumbFile}` },
    ]);
    expect(fs.existsSync(thumbPath)).toBe(true);

    const cleanupNoFlag = await runCli(["thumbnail", "cleanup", "--root", root, "--json"]);
    const cleanupNoFlagParsed = JSON.parse(cleanupNoFlag.stdout) as ThumbnailStatsJson;
    expect(cleanupNoFlagParsed.stale_stub_previews).toHaveLength(1);
    expect(fs.existsSync(thumbPath)).toBe(true); // left alone without the flag

    const cleanupWithFlag = await runCli([
      "thumbnail",
      "cleanup",
      "--root",
      root,
      "--delete-stale-stub-previews",
      "--json",
    ]);
    const cleanupWithFlagParsed = JSON.parse(cleanupWithFlag.stdout) as ThumbnailStatsJson;
    expect(cleanupWithFlagParsed.stale_stub_previews).toHaveLength(1);
    expect(fs.existsSync(thumbPath)).toBe(false); // actually removed with the flag

    fs.rmSync(root, { recursive: true, force: true });
  }, 60000);
});
