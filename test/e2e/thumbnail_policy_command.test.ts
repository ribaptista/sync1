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
  glob: string;
  action: string;
  priority: number | null;
  mime_types: string;
  image_width: number | null;
  image_height: number | null;
  tile_row_count: number | null;
  tile_column_count: number | null;
  tile_width: number | null;
  tile_height: number | null;
  jpeg_quality: number | null;
}

function readThumbnailPolicies(root: string): RawThumbnailPolicyRow[] {
  const db = new Database(path.join(root, ".sync1", "state.db"), { readonly: true });
  const rows = db
    .prepare(
      `SELECT id, glob, action, priority, mime_types, image_width, image_height,
       tile_row_count, tile_column_count, tile_width, tile_height, jpeg_quality
       FROM thumbnail_policies ORDER BY id`,
    )
    .all() as RawThumbnailPolicyRow[];
  db.close();
  return rows;
}

const GENERATE_FLAGS = [
  "--image-width",
  "320",
  "--image-height",
  "240",
  "--tile-rows",
  "4",
  "--tile-columns",
  "4",
  "--tile-width",
  "160",
  "--tile-height",
  "90",
  "--jpeg-quality",
  "80",
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
        "--mime-types",
        "image/jpeg",
        ...GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(create.exitCode).toBe(0);
    const createParsed = JSON.parse(create.stdout) as { ok: boolean; id: number; action: string };
    expect(createParsed.ok).toBe(true);
    expect(createParsed.action).toBe("generate");
    const id = createParsed.id;

    expect(readThumbnailPolicies(root)).toEqual([
      {
        id,
        glob: "**/*.jpg",
        action: "generate",
        priority: 0,
        mime_types: JSON.stringify(["image/jpeg"]),
        image_width: 320,
        image_height: 240,
        tile_row_count: 4,
        tile_column_count: 4,
        tile_width: 160,
        tile_height: 90,
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

  it("creates a skip policy with no generate fields and no priority", async () => {
    const root = await initVault(localstack);

    const create = await runCli(
      [
        "thumbnail_policy",
        "create",
        "private/**",
        "skip",
        "--root",
        root,
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
        glob: "private/**",
        action: "skip",
        priority: null,
        mime_types: JSON.stringify(["image/*", "video/*"]),
        image_width: null,
        image_height: null,
        tile_row_count: null,
        tile_column_count: null,
        tile_width: null,
        tile_height: null,
        jpeg_quality: null,
      },
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("auto-assigns an appended priority among generate policies when --priority is omitted", async () => {
    const root = await initVault(localstack);

    await runCli(
      [
        "thumbnail_policy",
        "create",
        "a/*",
        "generate",
        "--root",
        root,
        "--mime-types",
        "image/jpeg",
        ...GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    await runCli(
      [
        "thumbnail_policy",
        "create",
        "b/*",
        "generate",
        "--root",
        root,
        "--mime-types",
        "image/jpeg",
        ...GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    const third = await runCli(
      [
        "thumbnail_policy",
        "create",
        "c/*",
        "generate",
        "--root",
        root,
        "--mime-types",
        "image/jpeg",
        "--priority",
        "5",
        ...GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(third.exitCode).toBe(0);
    await runCli(
      [
        "thumbnail_policy",
        "create",
        "d/*",
        "generate",
        "--root",
        root,
        "--mime-types",
        "image/jpeg",
        ...GENERATE_FLAGS,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );

    expect(readThumbnailPolicies(root).map((r) => r.priority)).toEqual([0, 1, 5, 6]);

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
        "--mime-types",
        "image/jpeg",
        "--jpeg-quality",
        "80",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(skipWithGenerateFields.exitCode).not.toBe(0);

    const generateMissingFields = await runCli(
      [
        "thumbnail_policy",
        "create",
        "a/*",
        "generate",
        "--root",
        root,
        "--mime-types",
        "image/jpeg",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(generateMissingFields.exitCode).not.toBe(0);

    const invalidAction = await runCli(
      [
        "thumbnail_policy",
        "create",
        "a/*",
        "not-an-action",
        "--root",
        root,
        "--mime-types",
        "image/jpeg",
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(invalidAction.exitCode).not.toBe(0);

    expect(readThumbnailPolicies(root)).toEqual([]);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
