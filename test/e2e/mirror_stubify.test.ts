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
    // A skip is a failure, not a clean run -- stubify used to report
    // ok:false here and still exit 0.
    expect(refused.exitCode).not.toBe(0);
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

  /**
   * The failure this gate exists to prevent, and the one that made
   * `--skip-mirror`/`--allow-unmirrored` insufficient reasoning on their
   * own: `mirrorObjectExists` maps `ENOENT` to "not present", which is
   * indistinguishable from "the whole drive is gone" -- a genuinely
   * mirrored file and an unmounted mirror look identical to a per-row
   * `statSync`. Left unchecked, unplugging the drive and running
   * `stubify` used to report every row as "not yet mirrored" (blaming the
   * file) and still exit 0, so a caller doing `stubify && …` would
   * proceed as though it had succeeded.
   *
   * The fix is a precondition, not a per-row check: refuse to run at all
   * when a configured mirror cannot currently be reached, the same way
   * `sync1 mirror verify` already refuses rather than reporting a
   * comforting zero.
   */
  it("fails the whole run, not just per-row, when a configured mirror is unreachable", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTemp("gate-root");
    const mirror = mkTemp("gate-drive");

    await initVault(root, bucket);
    setMirrorPath(root, mirror);
    fs.writeFileSync(path.join(root, "a.txt"), "genuinely mirrored before the drive vanished");
    await runCli(["update_cache", "--root", root, "--json"]);
    const synced = await runCli(["sync", "--root", root, "--json"], { env });
    expect((JSON.parse(synced.stdout) as { mirrored_objects: number }).mirrored_objects).toBe(1);

    // Simulate an unmounted/disconnected drive: the configured path no
    // longer resolves to anything at all.
    fs.rmSync(mirror, { recursive: true, force: true });

    const result = await runCli(["stubify", "a.txt", "--root", root, "--json"]);
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; error: string };
    // The command-level error shape (ok/error), not the per-row
    // stats/skipped shape -- this must never look like "one file was
    // skipped", it has to look like "the run itself could not proceed".
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain(mirror);
    expect(parsed.error).toMatch(/does not exist or is not reachable/);

    // Nothing was touched -- the command refused before processing any row.
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "a.txt.stub"))).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
