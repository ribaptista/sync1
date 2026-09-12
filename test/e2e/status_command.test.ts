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

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-status-"));
}

async function sync(root: string) {
  return runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });
}

async function createPolicy(root: string, glob: string, targetClass: string, priority?: number) {
  const args = ["storage_policy", "create", glob, targetClass, "--root", root, "--json"];
  if (priority !== undefined) args.push("--priority", String(priority));
  const result = await runCli(args, { env: { SYNC1_PASSWORD: PASSWORD } });
  expect(result.exitCode).toBe(0);
}

async function status(root: string, filter?: string) {
  const args = ["status", "--root", root, "--json"];
  if (filter) args.push("--filter", filter);
  const result = await runCli(args);
  return { ...result, parsed: JSON.parse(result.stdout) as Record<string, unknown> };
}

describe("status", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("reports already_correct for content matching only the default (STANDARD) policy", async () => {
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
    fs.writeFileSync(path.join(root, "plain.txt"), "nothing special");
    const s = await sync(root);
    expect(s.exitCode).toBe(0);

    const result = await status(root);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toMatchObject({
      ok: true,
      already_correct: 1,
      changed_immediate: 0,
      restore_requested: 0,
      restore_pending: 0,
      finalized: 0,
      conflicts: [],
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports changed_immediate when a policy implies a colder class than the object's actual one", async () => {
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
    fs.writeFileSync(path.join(root, "archive-me.txt"), "cold storage candidate");
    await sync(root);
    await createPolicy(root, "archive-me.txt", "DEEP_ARCHIVE");

    const result = await status(root);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toMatchObject({
      already_correct: 0,
      changed_immediate: 1,
      conflicts: [],
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("detects a dedup warmest-wins conflict when two paths sharing content imply different classes", async () => {
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
    fs.writeFileSync(path.join(root, "cold-copy.txt"), "shared content");
    fs.writeFileSync(path.join(root, "warm-copy.txt"), "shared content"); // same bytes -> same hash
    await sync(root);
    await createPolicy(root, "cold-copy.txt", "DEEP_ARCHIVE");
    // warm-copy.txt matches no non-default policy -> falls back to the
    // default (STANDARD) -- the two paths now disagree on this shared hash.

    const result = await status(root);
    expect(result.exitCode).toBe(0);
    // actual object is still STANDARD (freshly synced, never archived) and
    // warmest-wins resolves the conflict to STANDARD too, so it's
    // "already correct" -- but the disagreement itself is still surfaced.
    expect(result.parsed).toMatchObject({ already_correct: 1, changed_immediate: 0 });
    const conflicts = result.parsed.conflicts as Array<{
      hash: string;
      paths: string[];
      target_class: string;
    }>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.target_class).toBe("STANDARD");
    expect(conflicts[0]!.paths.sort()).toEqual(["cold-copy.txt", "warm-copy.txt"]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("scopes which hashes are considered via --filter, without excluding a hash's other referencing paths", async () => {
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
    fs.mkdirSync(path.join(root, "keep"));
    fs.mkdirSync(path.join(root, "other"));
    fs.writeFileSync(path.join(root, "keep", "a.txt"), "kept content");
    fs.writeFileSync(path.join(root, "other", "b.txt"), "other content");
    await sync(root);
    await createPolicy(root, "keep/*", "DEEP_ARCHIVE");
    await createPolicy(root, "other/*", "DEEP_ARCHIVE");

    const result = await status(root, "keep/*");
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toMatchObject({ changed_immediate: 1, conflicts: [] }); // only keep/a.txt's object

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fails cleanly when the root was never initialized/attached", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-status-bare-"));
    const result = await status(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.error).toMatch(/does not exist/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
