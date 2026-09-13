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
import { getObject } from "../../src/s3/client.js";
import { parseManifest } from "../../src/vault/manifest.js";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-root-"));
}

describe("init_remote", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("creates the vault manifest, initial state.db snapshot, and /current pointer in S3", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();

    const result = await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--prefix",
        "myvault",
        "--root",
        root,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: "correct horse battery staple" } },
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; version_stamp: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.version_stamp).toMatch(/^\d{8}T\d{9}Z-[0-9a-f]{8}$/);

    // vault.json exists in S3 and is a well-formed manifest
    const vaultJsonObj = await getObject(s3, bucket, "myvault/vault.json");
    expect(vaultJsonObj).not.toBeNull();
    const manifest = parseManifest(vaultJsonObj!.body);
    expect(manifest.kdf).toBe("argon2id");

    // states/<version_stamp> exists (encrypted, so just check it's present and non-trivial)
    const stateSnapshot = await getObject(s3, bucket, `myvault/states/${parsed.version_stamp}`);
    expect(stateSnapshot).not.toBeNull();
    expect(stateSnapshot!.body.length).toBeGreaterThan(0);

    // /current points at the same version stamp
    const current = await getObject(s3, bucket, "myvault/current");
    expect(current).not.toBeNull();
    expect(current!.body.toString("utf8")).toBe(parsed.version_stamp);

    // local .sync1/ layout
    expect(fs.existsSync(path.join(root, ".sync1", "state.db"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".sync1", "vault.json"))).toBe(true);
    expect(fs.readFileSync(path.join(root, ".sync1", "last_synced_version"), "utf8")).toBe(
      parsed.version_stamp,
    );

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses to init against a non-empty S3 location", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const firstRoot = mkTempRoot();

    const first = await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        firstRoot,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: "pw" } },
    );
    expect(first.exitCode).toBe(0);

    const secondRoot = mkTempRoot();
    const second = await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        secondRoot,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: "pw" } },
    );

    expect(second.exitCode).not.toBe(0);
    const parsed = JSON.parse(second.stdout) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/not empty/);
    // A failed attempt may leave a bare .sync1/ behind (it's created early,
    // to hold the per-vault lock before any network work) -- but never
    // vault.json, which is only written at the very end of success. That's
    // the invariant a retry against the same root actually depends on.
    expect(fs.existsSync(path.join(secondRoot, ".sync1", "vault.json"))).toBe(false);

    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  });

  it("recovers from a bare .sync1/ left by a prior failed attempt", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();
    // Simulates a crash partway through a prior attempt (before vault.json
    // was ever written) -- .sync1/ exists, but the vault was never actually
    // created.
    fs.mkdirSync(path.join(root, ".sync1"));

    const result = await runCli(
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
      { env: { SYNC1_PASSWORD: "pw" } },
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(fs.existsSync(path.join(root, ".sync1", "vault.json"))).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses to re-init a root that's already fully initialized", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();

    const first = await runCli(
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
      { env: { SYNC1_PASSWORD: "pw" } },
    );
    expect(first.exitCode).toBe(0);

    const second = await runCli(
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
      { env: { SYNC1_PASSWORD: "pw" } },
    );

    expect(second.exitCode).not.toBe(0);
    const parsed = JSON.parse(second.stdout) as { ok: boolean; error: string };
    expect(parsed.error).toMatch(/already exists/);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
