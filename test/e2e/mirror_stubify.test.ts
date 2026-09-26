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
const env = { SYNC1_PASSWORD: PASSWORD };

function mkTemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sync1-e2e-${prefix}-`));
}

function setMirrorPath(root: string, mirrorPath: string): void {
  const configPath = path.join(root, ".sync1", "remote.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.mirror_path = mirrorPath;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

interface StubifyJson {
  ok: boolean;
  stubified: number;
  already_stub: number;
  skipped: { path: string; reason: string }[];
}

/**
 * `stubify` deletes the last local copy of a file's content. The gate is
 * what stops it doing that on the strength of a single remote copy when a
 * second was supposed to exist.
 *
 * It is mostly redundant by construction -- a mirror failure fails the
 * object, so a row that reached `unchanged` was mirrored -- which is
 * exactly why these tests reach for the two cases that escape that:
 * `--skip-mirror`, and content committed before a mirror was configured.
 */
describe("stubify's mirror gate", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  async function initVault(root: string, bucket: string): Promise<void> {
    await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--prefix",
        "v0",
        "--root",
        root,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env },
    );
  }

  it("refuses an unmirrored file, proceeds under --allow-unmirrored, and stops objecting after catchup", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTemp("gate-root");
    const mirror = mkTemp("gate-drive");

    await initVault(root, bucket);
    setMirrorPath(root, mirror);

    fs.writeFileSync(path.join(root, "a.txt"), "content committed without a mirror copy");
    await runCli(["update_cache", "--root", root, "--json"]);
    // --skip-mirror is one of the two ways to produce a committed object
    // with no second copy. The gate exists for exactly this state.
    const synced = await runCli(["sync", "--root", root, "--skip-mirror", "--json"], { env });
    expect(synced.exitCode).toBe(0);

    const refused = await runCli(["stubify", "a.txt", "--root", root, "--json"]);
    const refusedJson = JSON.parse(refused.stdout) as StubifyJson;
    expect(refusedJson.stubified).toBe(0);
    expect(refusedJson.ok).toBe(false);
    expect(refusedJson.skipped[0]?.reason).toContain("not yet mirrored");
    // The real file is untouched -- the point of refusing.
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe(
      "content committed without a mirror copy",
    );

    // The escape hatch still works, for someone who means it.
    const forced = await runCli([
      "stubify",
      "a.txt",
      "--root",
      root,
      "--allow-unmirrored",
      "--json",
    ]);
    expect((JSON.parse(forced.stdout) as StubifyJson).stubified).toBe(1);
    expect(fs.existsSync(path.join(root, "a.txt.stub"))).toBe(true);

    // Put it back, close the gap properly, and the gate falls silent.
    await runCli(["materialize", "a.txt", "--root", root, "--json"], { env });
    const caught = await runCli(["mirror", "catchup", "--root", root, "--json"], { env });
    expect((JSON.parse(caught.stdout) as { recovered: number }).recovered).toBe(1);

    const allowed = await runCli(["stubify", "a.txt", "--root", root, "--json"]);
    const allowedJson = JSON.parse(allowed.stdout) as StubifyJson;
    expect(allowedJson.stubified).toBe(1);
    expect(allowedJson.ok).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });

  it("is inert when no mirror is configured, so existing vaults behave exactly as before", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTemp("gate-root");

    await initVault(root, bucket);
    fs.writeFileSync(path.join(root, "a.txt"), "no mirror anywhere in sight");
    await runCli(["update_cache", "--root", root, "--json"]);
    await runCli(["sync", "--root", root, "--json"], { env });

    const result = await runCli(["stubify", "a.txt", "--root", root, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout) as StubifyJson).toMatchObject({ ok: true, stubified: 1 });

    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * The gate must not need `state.db` or the password: `stubify` advertises
   * that it needs neither, and the check reads only `row.hash` off the
   * cache row it already has.
   */
  it("still needs no password", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTemp("gate-root");
    const mirror = mkTemp("gate-drive");

    await initVault(root, bucket);
    setMirrorPath(root, mirror);
    fs.writeFileSync(path.join(root, "a.txt"), "mirrored normally");
    await runCli(["update_cache", "--root", root, "--json"]);
    await runCli(["sync", "--root", root, "--json"], { env });

    // Deliberately no SYNC1_PASSWORD in the environment.
    const result = await runCli(["stubify", "a.txt", "--root", root, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout) as StubifyJson).toMatchObject({ ok: true, stubified: 1 });

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });
});
