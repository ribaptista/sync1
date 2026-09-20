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

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-thumbnail-policy-"));
}

interface RawThumbnailPolicyRow {
  id: number;
  name: string;
  glob: string;
  action: string;
  mime_types: string;
  media_type: string | null;
  resizing_strategy: string | null;
  image_width: number | null;
  image_height: number | null;
  shorter_side: number | null;
  output_type: string | null;
  tile_row_count: number | null;
  tile_column_count: number | null;
  tile_size: number | null;
  frame_count: number | null;
  frame_delay_ms: number | null;
  jpeg_quality: number | null;
}

function readThumbnailPolicies(root: string): RawThumbnailPolicyRow[] {
  const db = new Database(path.join(root, ".sync1", "state.db"), { readonly: true });
  const rows = db
    .prepare(
      `SELECT id, name, glob, action, mime_types, media_type, resizing_strategy, image_width,
       image_height, shorter_side, output_type, tile_row_count, tile_column_count, tile_size,
       frame_count, frame_delay_ms, jpeg_quality
       FROM thumbnail_policies ORDER BY id`,
    )
    .all() as RawThumbnailPolicyRow[];
  db.close();
  return rows;
}

const IMAGE_GENERATE_FLAGS = [
  "--media-type",
  "image",
  "--resizing-strategy",
  "fit_to_box",
  "--image-width",
  "320",
  "--image-height",
  "240",
  "--jpeg-quality",
  "80",
];

const IMAGE_SHORTER_SIDE_FLAGS = [
  "--media-type",
  "image",
  "--resizing-strategy",
  "resize_shorter_side",
  "--shorter-side",
  "150",
  "--jpeg-quality",
  "80",
];

const VIDEO_GENERATE_FLAGS = [
  "--media-type",
  "video",
  "--output-type",
  "mosaic",
  "--tile-rows",
  "4",
  "--tile-columns",
  "4",
  "--tile-size",
  "90",
  "--jpeg-quality",
  "80",
];

const VIDEO_GIF_FLAGS = [
  "--media-type",
  "video",
  "--output-type",
  "gif",
  "--tile-size",
  "64",
  "--frame-count",
  "8",
  "--frame-delay-ms",
  "100",
];

async function initVault(localstack: LocalStackHandle): Promise<string> {
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
  return root;
}

describe("thumbnail_policy command", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("round-trips list/create/edit/delete through real commits, starting empty (no default row)", async () => {
    const root = await initVault(localstack);

    const initialList = await runCli(["thumbnail_policy", "list", "--root", root, "--json"]);
    expect(initialList.exitCode).toBe(0);
    expect((JSON.parse(initialList.stdout) as { policies: unknown[] }).policies).toEqual([]);

    const create = await runCli(
      [
        "thumbnail_policy",
        "create",
        "**/*.jpg",
        "generate",
        "--root",
        root,
        "--name",
        "jpg_thumb",
        "--mime-types",
        "image/jpeg",
        ...IMAGE_GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(create.exitCode).toBe(0);
    const createParsed = JSON.parse(create.stdout) as {
      ok: boolean;
      id: number;
      name: string;
      action: string;
    };
    expect(createParsed.ok).toBe(true);
    expect(createParsed.name).toBe("jpg_thumb");
    expect(createParsed.action).toBe("generate");
    const id = createParsed.id;

    expect(readThumbnailPolicies(root)).toEqual([
      {
        id,
        name: "jpg_thumb",
        glob: "**/*.jpg",
        action: "generate",
        mime_types: JSON.stringify(["image/jpeg"]),
        media_type: "image",
        resizing_strategy: "fit_to_box",
        image_width: 320,
        image_height: 240,
        shorter_side: null,
        output_type: null,
        tile_row_count: null,
        tile_column_count: null,
        tile_size: null,
        frame_count: null,
        frame_delay_ms: null,
        jpeg_quality: 80,
      },
    ]);

    const edit = await runCli(
      ["thumbnail_policy", "edit", String(id), "--jpeg-quality", "60", "--root", root, "--json"],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(edit.exitCode).toBe(0);
    expect(readThumbnailPolicies(root)[0]).toMatchObject({ jpeg_quality: 60 });

    const editMissing = await runCli(
      ["thumbnail_policy", "edit", "9999", "--jpeg-quality", "50", "--root", root, "--json"],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(editMissing.exitCode).not.toBe(0);

    const del = await runCli(["thumbnail_policy", "delete", String(id), "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(del.exitCode).toBe(0);
    expect(readThumbnailPolicies(root)).toEqual([]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates a video generate policy with --tile-size instead of a fixed tile box", async () => {
    const root = await initVault(localstack);

    const create = await runCli(
      [
        "thumbnail_policy",
        "create",
        "**/*.mp4",
        "generate",
        "--root",
        root,
        "--name",
        "mp4_thumb",
        "--mime-types",
        "video/*",
        ...VIDEO_GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(create.exitCode).toBe(0);

    expect(readThumbnailPolicies(root)).toEqual([
      {
        id: expect.any(Number) as number,
        name: "mp4_thumb",
        glob: "**/*.mp4",
        action: "generate",
        mime_types: JSON.stringify(["video/*"]),
        media_type: "video",
        resizing_strategy: null,
        image_width: null,
        image_height: null,
        shorter_side: null,
        output_type: "mosaic",
        tile_row_count: 4,
        tile_column_count: 4,
        tile_size: 90,
        frame_count: null,
        frame_delay_ms: null,
        jpeg_quality: 80,
      },
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates a skip policy with no generate fields and no media type", async () => {
    const root = await initVault(localstack);

    const create = await runCli(
      [
        "thumbnail_policy",
        "create",
        "private/**",
        "skip",
        "--root",
        root,
        "--name",
        "skip_private",
        "--mime-types",
        "image/*,video/*",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(create.exitCode).toBe(0);

    expect(readThumbnailPolicies(root)).toEqual([
      {
        id: expect.any(Number) as number,
        name: "skip_private",
        glob: "private/**",
        action: "skip",
        mime_types: JSON.stringify(["image/*", "video/*"]),
        media_type: null,
        resizing_strategy: null,
        image_width: null,
        image_height: null,
        shorter_side: null,
        output_type: null,
        tile_row_count: null,
        tile_column_count: null,
        tile_size: null,
        frame_count: null,
        frame_delay_ms: null,
        jpeg_quality: null,
      },
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates an image/resize_shorter_side generate policy", async () => {
    const root = await initVault(localstack);

    const create = await runCli(
      [
        "thumbnail_policy",
        "create",
        "**/*.jpg",
        "generate",
        "--root",
        root,
        "--name",
        "jpg_short",
        "--mime-types",
        "image/jpeg",
        ...IMAGE_SHORTER_SIDE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(create.exitCode).toBe(0);

    expect(readThumbnailPolicies(root)).toEqual([
      {
        id: expect.any(Number) as number,
        name: "jpg_short",
        glob: "**/*.jpg",
        action: "generate",
        mime_types: JSON.stringify(["image/jpeg"]),
        media_type: "image",
        resizing_strategy: "resize_shorter_side",
        image_width: null,
        image_height: null,
        shorter_side: 150,
        output_type: null,
        tile_row_count: null,
        tile_column_count: null,
        tile_size: null,
        frame_count: null,
        frame_delay_ms: null,
        jpeg_quality: 80,
      },
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates a video/gif generate policy -- no jpeg_quality, since a GIF is never JPEG", async () => {
    const root = await initVault(localstack);

    const create = await runCli(
      [
        "thumbnail_policy",
        "create",
        "**/*.mp4",
        "generate",
        "--root",
        root,
        "--name",
        "mp4_gif",
        "--mime-types",
        "video/*",
        ...VIDEO_GIF_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(create.exitCode).toBe(0);

    expect(readThumbnailPolicies(root)).toEqual([
      {
        id: expect.any(Number) as number,
        name: "mp4_gif",
        glob: "**/*.mp4",
        action: "generate",
        mime_types: JSON.stringify(["video/*"]),
        media_type: "video",
        resizing_strategy: null,
        image_width: null,
        image_height: null,
        shorter_side: null,
        output_type: "gif",
        tile_row_count: null,
        tile_column_count: null,
        tile_size: 64,
        frame_count: 8,
        frame_delay_ms: 100,
        jpeg_quality: null,
      },
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects --resizing-strategy on a video policy, and --output-type on an image policy", async () => {
    const root = await initVault(localstack);

    const imageWithOutputType = await runCli(
      [
        "thumbnail_policy",
        "create",
        "a/*",
        "generate",
        "--root",
        root,
        "--name",
        "bad1",
        "--mime-types",
        "image/jpeg",
        "--media-type",
        "image",
        "--output-type",
        "mosaic",
        "--image-width",
        "10",
        "--image-height",
        "10",
        "--jpeg-quality",
        "80",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(imageWithOutputType.exitCode).not.toBe(0);

    const videoWithResizingStrategy = await runCli(
      [
        "thumbnail_policy",
        "create",
        "a/*",
        "generate",
        "--root",
        root,
        "--name",
        "bad2",
        "--mime-types",
        "video/mp4",
        "--media-type",
        "video",
        "--resizing-strategy",
        "fit_to_box",
        "--output-type",
        "mosaic",
        "--tile-rows",
        "4",
        "--tile-columns",
        "4",
        "--tile-size",
        "90",
        "--jpeg-quality",
        "80",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(videoWithResizingStrategy.exitCode).not.toBe(0);

    expect(readThumbnailPolicies(root)).toEqual([]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects a duplicate policy name", async () => {
    const root = await initVault(localstack);

    await runCli(
      [
        "thumbnail_policy",
        "create",
        "a/*",
        "generate",
        "--root",
        root,
        "--name",
        "dup",
        "--mime-types",
        "image/jpeg",
        ...IMAGE_GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    const second = await runCli(
      [
        "thumbnail_policy",
        "create",
        "b/*",
        "generate",
        "--root",
        root,
        "--name",
        "dup",
        "--mime-types",
        "image/jpeg",
        ...IMAGE_GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(second.exitCode).not.toBe(0);
    expect(readThumbnailPolicies(root)).toHaveLength(1);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("every matching 'generate' policy commits independently -- no priority, no single winner", async () => {
    const root = await initVault(localstack);

    for (const name of ["a", "b", "c", "d"]) {
      const created = await runCli(
        [
          "thumbnail_policy",
          "create",
          `${name}/*`,
          "generate",
          "--root",
          root,
          "--name",
          name,
          "--mime-types",
          "image/jpeg",
          ...IMAGE_GENERATE_FLAGS,
          "--json",
        ],
        { env: { SYNC1_PASSWORD: PASSWORD } },
      );
      expect(created.exitCode).toBe(0);
    }

    expect(readThumbnailPolicies(root).map((r) => r.name)).toEqual(["a", "b", "c", "d"]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects create with inconsistent flags before any commit", async () => {
    const root = await initVault(localstack);

    const skipWithGenerateFields = await runCli(
      [
        "thumbnail_policy",
        "create",
        "a/*",
        "skip",
        "--root",
        root,
        "--name",
        "p1",
        "--mime-types",
        "image/jpeg",
        "--jpeg-quality",
        "80",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(skipWithGenerateFields.exitCode).not.toBe(0);

    const generateMissingMediaType = await runCli(
      [
        "thumbnail_policy",
        "create",
        "a/*",
        "generate",
        "--root",
        root,
        "--name",
        "p2",
        "--mime-types",
        "image/jpeg",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(generateMissingMediaType.exitCode).not.toBe(0);

    const generateMissingFields = await runCli(
      [
        "thumbnail_policy",
        "create",
        "a/*",
        "generate",
        "--root",
        root,
        "--name",
        "p3",
        "--mime-types",
        "image/jpeg",
        "--media-type",
        "image",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(generateMissingFields.exitCode).not.toBe(0);

    // Fields from the *other* media type are also rejected, not just
    // ignored -- the whole point of splitting the schema by media_type.
    const generateWrongTypeFields = await runCli(
      [
        "thumbnail_policy",
        "create",
        "a/*",
        "generate",
        "--root",
        root,
        "--name",
        "p4",
        "--mime-types",
        "image/jpeg",
        ...IMAGE_GENERATE_FLAGS,
        "--tile-rows",
        "4",
        "--tile-columns",
        "4",
        "--tile-size",
        "90",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(generateWrongTypeFields.exitCode).not.toBe(0);

    const invalidAction = await runCli(
      [
        "thumbnail_policy",
        "create",
        "a/*",
        "not-an-action",
        "--root",
        root,
        "--name",
        "p5",
        "--mime-types",
        "image/jpeg",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(invalidAction.exitCode).not.toBe(0);

    const invalidName = await runCli(
      [
        "thumbnail_policy",
        "create",
        "a/*",
        "skip",
        "--root",
        root,
        "--name",
        "has-a-dash",
        "--mime-types",
        "image/jpeg",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(invalidName.exitCode).not.toBe(0);

    expect(readThumbnailPolicies(root)).toEqual([]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects an edit that sets fields from both media types at once", async () => {
    const root = await initVault(localstack);

    const create = await runCli(
      [
        "thumbnail_policy",
        "create",
        "**/*.jpg",
        "generate",
        "--root",
        root,
        "--name",
        "jpg_thumb",
        "--mime-types",
        "image/jpeg",
        ...IMAGE_GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    const id = (JSON.parse(create.stdout) as { id: number }).id;

    const edit = await runCli(
      [
        "thumbnail_policy",
        "edit",
        String(id),
        "--image-width",
        "50",
        "--tile-size",
        "50",
        "--root",
        root,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(edit.exitCode).not.toBe(0);
    expect(readThumbnailPolicies(root)[0]).toMatchObject({ image_width: 320 }); // unchanged

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("edit switching media type requires resupplying mime types and the new type's fields, and carries jpegQuality", async () => {
    const root = await initVault(localstack);

    const create = await runCli(
      [
        "thumbnail_policy",
        "create",
        "**/*",
        "generate",
        "--root",
        root,
        "--name",
        "any_thumb",
        "--mime-types",
        "image/jpeg",
        ...IMAGE_GENERATE_FLAGS,
        "--jpeg-quality",
        "77",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    const id = (JSON.parse(create.stdout) as { id: number }).id;

    // Switching to 'video' without resupplying mime types fails -- the old
    // image/jpeg mime type no longer matches the 'video' media type.
    const editMissingMimeTypes = await runCli(
      [
        "thumbnail_policy",
        "edit",
        String(id),
        "--media-type",
        "video",
        "--output-type",
        "mosaic",
        "--tile-rows",
        "2",
        "--tile-columns",
        "2",
        "--tile-size",
        "50",
        "--root",
        root,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(editMissingMimeTypes.exitCode).not.toBe(0);

    const edit = await runCli(
      [
        "thumbnail_policy",
        "edit",
        String(id),
        "--media-type",
        "video",
        "--output-type",
        "mosaic",
        "--mime-types",
        "video/mp4",
        "--tile-rows",
        "2",
        "--tile-columns",
        "2",
        "--tile-size",
        "50",
        "--root",
        root,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(edit.exitCode).toBe(0);

    expect(readThumbnailPolicies(root)[0]).toMatchObject({
      media_type: "video",
      output_type: "mosaic",
      mime_types: JSON.stringify(["video/mp4"]),
      image_width: null,
      image_height: null,
      tile_row_count: 2,
      tile_column_count: 2,
      tile_size: 50,
      jpeg_quality: 77, // carried across the image<->video switch, untouched
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("edit switching outputType mosaic->gif carries tileSize but drops jpegQuality", async () => {
    const root = await initVault(localstack);

    const create = await runCli(
      [
        "thumbnail_policy",
        "create",
        "**/*.mp4",
        "generate",
        "--root",
        root,
        "--name",
        "mp4_thumb",
        "--mime-types",
        "video/*",
        ...VIDEO_GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    const id = (JSON.parse(create.stdout) as { id: number }).id;

    const edit = await runCli(
      [
        "thumbnail_policy",
        "edit",
        String(id),
        "--output-type",
        "gif",
        "--frame-count",
        "6",
        "--frame-delay-ms",
        "80",
        "--root",
        root,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(edit.exitCode).toBe(0);

    expect(readThumbnailPolicies(root)[0]).toMatchObject({
      media_type: "video",
      output_type: "gif",
      tile_row_count: null,
      tile_column_count: null,
      tile_size: 90, // carried -- 'mosaic' and 'gif' share this field
      frame_count: 6,
      frame_delay_ms: 80,
      jpeg_quality: null, // dropped -- a GIF is never JPEG
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("edit can rename a policy", async () => {
    const root = await initVault(localstack);

    const create = await runCli(
      [
        "thumbnail_policy",
        "create",
        "**/*.jpg",
        "generate",
        "--root",
        root,
        "--name",
        "old_name",
        "--mime-types",
        "image/jpeg",
        ...IMAGE_GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    const id = (JSON.parse(create.stdout) as { id: number }).id;

    const edit = await runCli(
      ["thumbnail_policy", "edit", String(id), "--name", "new_name", "--root", root, "--json"],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(edit.exitCode).toBe(0);
    expect(readThumbnailPolicies(root)[0]).toMatchObject({ name: "new_name" });

    fs.rmSync(root, { recursive: true, force: true });
  });
});
