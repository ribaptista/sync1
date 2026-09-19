import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-thumbnail-"));
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

describe("thumbnail command", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("state reports to_generate, ensure generates real thumbnail files, cleanup leaves them alone, a re-run reports up_to_date", async () => {
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

    const createPolicy = await runCli(
      [
        "thumbnail_policy",
        "create",
        "*.jpg",
        "generate",
        "--root",
        root,
        "--mime-types",
        "image/jpeg",
        "--media-type",
        "image",
        "--image-width",
        "16",
        "--image-height",
        "16",
        "--jpeg-quality",
        "80",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(createPolicy.exitCode).toBe(0);

    const updateCache = await runCli(["update_cache", "--root", root, "--json"]);
    expect(updateCache.exitCode).toBe(0);

    const state1 = await runCli(["thumbnail", "state", "--root", root, "--json"]);
    expect(state1.exitCode).toBe(0);
    const state1Parsed = JSON.parse(state1.stdout) as ThumbnailStatsJson;
    expect(state1Parsed).toMatchObject({ ok: true, to_generate: 1, up_to_date: 0 });
    // state never writes anything
    expect(fs.existsSync(path.join(root, "_thumbnail"))).toBe(false);

    const ensure1 = await runCli(["thumbnail", "ensure", "--root", root, "--json"]);
    expect(ensure1.exitCode).toBe(0);
    const ensure1Parsed = JSON.parse(ensure1.stdout) as ThumbnailStatsJson;
    expect(ensure1Parsed).toMatchObject({ ok: true, to_generate: 1, errors: 0 });

    const thumbnailFiles = fs.readdirSync(path.join(root, "_thumbnail"));
    expect(thumbnailFiles).toHaveLength(1);
    expect(thumbnailFiles[0]).toMatch(/^photo\.jpg\.p1-iw16-ih16-q80\.[0-9a-f]+\.jpg$/);

    const cleanup1 = await runCli(["thumbnail", "cleanup", "--root", root, "--json"]);
    expect(cleanup1.exitCode).toBe(0);
    const cleanup1Parsed = JSON.parse(cleanup1.stdout) as ThumbnailStatsJson;
    expect(cleanup1Parsed).toMatchObject({ ok: true, to_delete: 0 });
    expect(fs.readdirSync(path.join(root, "_thumbnail"))).toHaveLength(1); // cleanup never touches an up-to-date thumbnail

    const state2 = await runCli(["thumbnail", "state", "--root", root, "--json"]);
    const state2Parsed = JSON.parse(state2.stdout) as ThumbnailStatsJson;
    expect(state2Parsed).toMatchObject({ ok: true, up_to_date: 1, to_generate: 0 });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("--glob scopes which files a run considers, passed through to a real invocation", async () => {
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

    fs.mkdirSync(path.join(root, "InScope"));
    fs.mkdirSync(path.join(root, "OutOfScope"));
    fs.copyFileSync(path.join(FIXTURES_DIR, "tiny.jpg"), path.join(root, "InScope", "a.jpg"));
    fs.copyFileSync(path.join(FIXTURES_DIR, "tiny.jpg"), path.join(root, "OutOfScope", "b.jpg"));

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
        "--media-type",
        "image",
        "--image-width",
        "16",
        "--image-height",
        "16",
        "--jpeg-quality",
        "80",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    await runCli(["update_cache", "--root", root, "--json"]);

    const state = await runCli([
      "thumbnail",
      "state",
      "--root",
      root,
      "--glob",
      "InScope/*.jpg",
      "--json",
    ]);
    expect(state.exitCode).toBe(0);
    const parsed = JSON.parse(state.stdout) as ThumbnailStatsJson;
    expect(parsed).toMatchObject({ to_generate: 1 }); // only InScope/a.jpg

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fails cleanly when the root was never initialized/attached", async () => {
    const root = mkTempRoot();
    const result = await runCli(["thumbnail", "state", "--root", root, "--json"]);
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; error: string };
    expect(parsed.error).toMatch(/does not exist/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
