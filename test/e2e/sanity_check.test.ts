import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";
import { hashBufferHex } from "../../src/crypto/hash.js";
import { objectKey } from "../../src/vault/paths.js";

const PASSWORD = "correct horse battery staple";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-sanity-"));
}

async function sanityCheck(root: string, filter?: string) {
  const args = ["sanity_check", "--root", root, "--json"];
  if (filter) args.push("--filter", filter);
  const result = await runCli(args);
  return { ...result, parsed: JSON.parse(result.stdout) as Record<string, unknown> };
}

async function sync(root: string) {
  return runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });
}

describe("sanity_check", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("reports no problems for a freshly-synced, untouched vault", async () => {
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
    fs.writeFileSync(path.join(root, "clean.txt"), "clean content");
    const s = await sync(root);
    expect(s.exitCode).toBe(0);

    const result = await sanityCheck(root);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({
      ok: true,
      both_stub_and_real: [],
      hash_mismatch: [],
      stub_mismatch: [],
      missing_in_s3: [],
      missing_locally: [],
      untracked: [],
      ignored_count: 0,
      stale_temp_files: [],
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("detects each bad-state category in one comprehensive scan, exit code 1", async () => {
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

    fs.writeFileSync(path.join(root, "clean.txt"), "clean content");
    fs.writeFileSync(path.join(root, "tampered.txt"), "original content");
    fs.writeFileSync(path.join(root, "vanishing.txt"), "will vanish from s3");
    fs.writeFileSync(path.join(root, "ghost.txt"), "will vanish locally");
    fs.writeFileSync(path.join(root, "dual.txt"), "has a stray stub too");
    const s = await sync(root);
    expect(s.exitCode).toBe(0);

    // hash mismatch: tamper the real bytes directly, bypassing update_cache
    fs.writeFileSync(path.join(root, "tampered.txt"), "TAMPERED!!");

    // missing in S3: delete the backing object directly out of the bucket
    const vanishingHash = hashBufferHex(Buffer.from("will vanish from s3"));
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(vanishingHash) }));

    // missing locally: remove all local content for a tracked path
    fs.rmSync(path.join(root, "ghost.txt"));

    // both stub and real: a stray stub alongside its real, already-tracked file
    fs.writeFileSync(path.join(root, "dual.txt.stub"), "irrelevant stub bytes");

    // untracked + ignored: one plain untracked file, one matching a global ignore policy
    fs.writeFileSync(path.join(root, "untracked.txt"), "nobody tracks me");
    fs.writeFileSync(path.join(root, "scratch.tmp"), "throwaway");
    const ignoreCreate = await runCli(["ignore", "create", "*.tmp", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(ignoreCreate.exitCode).toBe(0);

    const result = await sanityCheck(root);
    expect(result.exitCode).toBe(1);
    expect(result.parsed.ok).toBe(false);

    expect(result.parsed.hash_mismatch).toEqual([
      {
        path: "tampered.txt",
        expected_hash: hashBufferHex(Buffer.from("original content")),
        actual_hash: hashBufferHex(Buffer.from("TAMPERED!!")),
      },
    ]);
    expect(result.parsed.missing_in_s3).toEqual([{ path: "vanishing.txt", hash: vanishingHash }]);
    expect(result.parsed.missing_locally).toEqual(["ghost.txt"]);
    expect(result.parsed.both_stub_and_real).toEqual(["dual.txt"]);
    expect(result.parsed.untracked).toEqual(["untracked.txt"]);
    expect(result.parsed.ignored_count).toBe(1);
    expect(result.parsed.stub_mismatch).toEqual([]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("scopes reported problems with --filter", async () => {
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
    fs.writeFileSync(path.join(root, "keep", "a.txt"), "kept original");
    fs.writeFileSync(path.join(root, "other", "b.txt"), "other original");
    await sync(root);

    fs.writeFileSync(path.join(root, "keep", "a.txt"), "kept tampered");
    fs.writeFileSync(path.join(root, "other", "b.txt"), "other tampered");

    const result = await sanityCheck(root, "keep/*");
    expect(result.exitCode).toBe(1);
    const hashMismatch = result.parsed.hash_mismatch as Array<{ path: string }>;
    expect(hashMismatch.map((m) => m.path)).toEqual(["keep/a.txt"]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("detects a corrupt stub via a second machine that only has the stub, never the real file", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const rootA = mkTempRoot();
    const rootB = mkTempRoot();

    await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        rootA,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    fs.writeFileSync(path.join(rootA, "remote_only.txt"), "shared content");
    await sync(rootA);

    await runCli(
      [
        "attach_remote",
        "--bucket",
        bucket,
        "--root",
        rootB,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    await sync(rootB); // B gets remote_only.txt as a stub -- never downloaded

    const stubPath = path.join(rootB, "remote_only.txt.stub");
    expect(fs.existsSync(stubPath)).toBe(true);
    fs.writeFileSync(stubPath, "not-a-valid-tagged-hash");

    const result = await sanityCheck(rootB);
    expect(result.exitCode).toBe(1);
    const stubMismatch = result.parsed.stub_mismatch as Array<{ path: string; reason: string }>;
    expect(stubMismatch).toHaveLength(1);
    expect(stubMismatch[0]!.path).toBe("remote_only.txt");
    expect(stubMismatch[0]!.reason).toMatch(/malformed stub content/);

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });

  it("fails cleanly when the root was never initialized/attached", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-sanity-bare-"));
    const result = await sanityCheck(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.error).toMatch(/does not exist/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
