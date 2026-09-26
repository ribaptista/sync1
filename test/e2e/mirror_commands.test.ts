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

function mirrorObjectFiles(mirror: string): string[] {
  const root = path.join(mirror, "objects");
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(full);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return out.sort();
}

interface VerifyJson {
  ok: boolean;
  mirror_version: string;
  reference_version: string | null;
  reference: string;
  up_to_date: boolean;
  depth: string;
  objects_checked?: number;
  missing?: number;
  wrong_size?: number;
  checksum_mismatch?: number;
  extra?: number;
  stale_temps: number;
}

describe("mirror verify / catchup / prune", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  /** A vault with `count` distinct files synced, and a mirror holding them. */
  async function vaultWithMirror(
    count: number,
  ): Promise<{ root: string; mirror: string; bucket: string }> {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTemp("cmd-root");
    const mirror = mkTemp("cmd-drive");

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
    setMirrorPath(root, mirror);

    for (let i = 0; i < count; i++) {
      fs.writeFileSync(path.join(root, `file-${i}.txt`), `content number ${i}`);
    }
    await runCli(["update_cache", "--root", root, "--json"]);
    const synced = await runCli(["sync", "--root", root, "--json"], { env });
    expect(synced.exitCode).toBe(0);

    return { root, mirror, bucket };
  }

  it("passes on a healthy mirror, at both depths, and reports it up to date", async () => {
    const { root, mirror } = await vaultWithMirror(3);

    const quick = await runCli(["mirror", "verify", "--quick", "--root", root, "--json"]);
    expect(quick.exitCode).toBe(0);
    const quickJson = JSON.parse(quick.stdout) as VerifyJson;
    expect(quickJson).toMatchObject({
      ok: true,
      up_to_date: true,
      reference: "s3",
      depth: "quick",
    });
    // --quick never asks for the password; it reads a pointer and stats a file.
    expect(quickJson.objects_checked).toBeUndefined();

    const deep = await runCli(["mirror", "verify", "--checksum", "--root", root, "--json"], {
      env,
    });
    expect(deep.exitCode).toBe(0);
    expect(JSON.parse(deep.stdout) as VerifyJson).toMatchObject({
      ok: true,
      depth: "checksum",
      objects_checked: 3,
      missing: 0,
      wrong_size: 0,
      checksum_mismatch: 0,
      extra: 0,
    });

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });

  /**
   * The two depths must genuinely read to different depths, not be one flag
   * wired to the same code. A flipped byte preserves the size, so only the
   * checksum pass can see it; a truncation changes the size, so the cheap
   * pass must catch that without being asked twice.
   */
  it("catches a flipped byte only with --checksum, and a truncation without it", async () => {
    const { root, mirror } = await vaultWithMirror(3);
    const objects = mirrorObjectFiles(mirror);

    const flipped = objects[0]!;
    const bytes = fs.readFileSync(flipped);
    // Same length, different content -- invisible to a size check, which
    // is precisely what separates the two depths.
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0xff, bytes.length - 1);
    fs.writeFileSync(flipped, bytes);

    const shallow = await runCli(["mirror", "verify", "--root", root, "--json"], { env });
    expect(JSON.parse(shallow.stdout) as VerifyJson).toMatchObject({
      ok: true,
      missing: 0,
      wrong_size: 0,
    });

    const deep = await runCli(["mirror", "verify", "--checksum", "--root", root, "--json"], {
      env,
    });
    expect(deep.exitCode).not.toBe(0);
    expect(JSON.parse(deep.stdout) as VerifyJson).toMatchObject({
      ok: false,
      checksum_mismatch: 1,
    });

    // Truncation shifts the size, so the cheap pass is enough.
    fs.truncateSync(objects[1]!, 4);
    const afterTruncate = await runCli(["mirror", "verify", "--root", root, "--json"], { env });
    expect(afterTruncate.exitCode).not.toBe(0);
    expect(JSON.parse(afterTruncate.stdout) as VerifyJson).toMatchObject({
      ok: false,
      wrong_size: 1,
    });

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });

  /**
   * What distinguishes this design from the obvious one. Measuring against
   * the local state.db would render both of these as heaps of missing
   * objects; measuring against the mirror's own `current` names the actual
   * fault in the first case and reports honest lag in the second.
   */
  it("reports a dangling pointer as the fault, and lag as lag", async () => {
    const { root, mirror } = await vaultWithMirror(2);
    const pointerPath = path.join(mirror, "current");
    const realVersion = fs.readFileSync(pointerPath, "utf8");

    // A `current` naming a snapshot the drive doesn't hold.
    fs.writeFileSync(pointerPath, "20990101T000000000Z-deadbeef");
    const dangling = await runCli(["mirror", "verify", "--root", root, "--json"], { env });
    expect(dangling.exitCode).not.toBe(0);
    const danglingJson = JSON.parse(dangling.stdout) as { ok: boolean; error: string };
    expect(danglingJson.ok).toBe(false);
    expect(danglingJson.error).toContain("cannot be restored from");
    // Emphatically NOT thousands of missing-object rows.
    expect(danglingJson.error).not.toContain("missing from the mirror");

    // Restored, then the vault moves on without the mirror.
    fs.writeFileSync(pointerPath, realVersion);
    fs.writeFileSync(path.join(root, "later.txt"), "added after the mirror was last written");
    await runCli(["update_cache", "--root", root, "--json"]);
    await runCli(["sync", "--root", root, "--skip-mirror", "--json"], { env });

    const behind = await runCli(["mirror", "verify", "--root", root, "--json"], { env });
    const behindJson = JSON.parse(behind.stdout) as VerifyJson;
    // Internally consistent at its own version: every object that version
    // references is present. It is simply behind, which is a fact, not
    // damage -- so `ok` stays true.
    expect(behindJson).toMatchObject({ ok: true, up_to_date: false, missing: 0 });
    expect(behindJson.mirror_version).not.toBe(behindJson.reference_version);

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });

  it("refuses a mirror belonging to a different vault before checking anything", async () => {
    const { root, mirror } = await vaultWithMirror(2);
    const manifest = JSON.parse(fs.readFileSync(path.join(mirror, "vault.json"), "utf8")) as Record<
      string,
      unknown
    >;
    manifest.kdf_params = { salt: "00000000000000000000000000000000", opslimit: 3, memlimit: 1 };
    fs.writeFileSync(path.join(mirror, "vault.json"), JSON.stringify(manifest, null, 2));

    const result = await runCli(["mirror", "verify", "--root", root, "--json"], { env });
    expect(result.exitCode).not.toBe(0);
    expect((JSON.parse(result.stdout) as { error: string }).error).toContain("another vault");

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });

  /**
   * The zero-egress claim: catchup rebuilds a missing object from local
   * plaintext with LocalStack still up but never asked for the bytes --
   * asserted by the object coming back byte-identical, which only
   * convergent encryption can produce.
   */
  it("rebuilds a deleted object from local plaintext, byte-identically", async () => {
    const { root, mirror } = await vaultWithMirror(3);
    const objects = mirrorObjectFiles(mirror);
    const victim = objects[0]!;
    const original = fs.readFileSync(victim);
    fs.rmSync(victim);

    const broken = await runCli(["mirror", "verify", "--root", root, "--json"], { env });
    expect(JSON.parse(broken.stdout) as VerifyJson).toMatchObject({ ok: false, missing: 1 });

    const caught = await runCli(["mirror", "catchup", "--root", root, "--json"], { env });
    expect(caught.exitCode).toBe(0);
    expect(
      JSON.parse(caught.stdout) as { recovered: number; unrecoverable_locally: number },
    ).toMatchObject({ recovered: 1, unrecoverable_locally: 0 });

    expect(fs.readFileSync(victim).equals(original)).toBe(true);

    const healed = await runCli(["mirror", "verify", "--checksum", "--root", root, "--json"], {
      env,
    });
    expect(healed.exitCode).toBe(0);
    expect(JSON.parse(healed.stdout) as VerifyJson).toMatchObject({ ok: true, missing: 0 });

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });

  /**
   * **The silent-corruption test.** `objects` has no path column, so
   * catchup finds a source through `entries.hash` -- and that path may have
   * been edited since. Encrypting it anyway would put ciphertext for
   * different content at `objects/../<H>`: a file that passes the cheap
   * size check and decrypts to the wrong bytes, which is strictly worse
   * than the hole it replaced.
   */
  it("never writes a stale source, and recovers from an unedited sibling instead", async () => {
    const { root, mirror } = await vaultWithMirror(0);

    // Two paths, identical content -> one object, two entries rows.
    const shared = "content shared by two paths exactly";
    fs.writeFileSync(path.join(root, "one.txt"), shared);
    fs.writeFileSync(path.join(root, "two.txt"), shared);
    await runCli(["update_cache", "--root", root, "--json"]);
    await runCli(["sync", "--root", root, "--json"], { env });

    const objects = mirrorObjectFiles(mirror);
    expect(objects).toHaveLength(1);
    const original = fs.readFileSync(objects[0]!);
    fs.rmSync(objects[0]!);

    // Edit ONE of the two, same length so nothing cheap notices, and keep
    // its mtime so update_cache's fast path leaves the row `unchanged` --
    // i.e. the row still claims the old hash. Only the authoritative
    // rehash inside the codec can tell.
    const edited = path.join(root, "one.txt");
    const { atime, mtime } = fs.statSync(edited);
    fs.writeFileSync(edited, "CONTENT SHARED BY TWO PATHS EXACTLY");
    fs.utimesSync(edited, atime, mtime);

    const caught = await runCli(["mirror", "catchup", "--root", root, "--json"], { env });
    expect(JSON.parse(caught.stdout) as { recovered: number }).toMatchObject({ recovered: 1 });

    // Recovered from two.txt, the sibling that was not touched -- and
    // byte-identical, so nothing from one.txt reached the drive.
    expect(fs.readFileSync(objects[0]!).equals(original)).toBe(true);

    // Now spoil the other one too: no usable source remains, and catchup
    // must leave the object missing rather than write a plausible lie.
    fs.rmSync(objects[0]!);
    const other = path.join(root, "two.txt");
    const stamps = fs.statSync(other);
    fs.writeFileSync(other, "content shared by two paths EXACTLY!");
    fs.utimesSync(other, stamps.atime, stamps.mtime);

    const stuck = await runCli(["mirror", "catchup", "--root", root, "--json"], { env });
    expect(
      JSON.parse(stuck.stdout) as { recovered: number; unrecoverable_locally: number },
    ).toMatchObject({ recovered: 0, unrecoverable_locally: 1 });
    expect(stuck.exitCode).not.toBe(0);
    expect(fs.existsSync(objects[0]!)).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });

  /**
   * Pins the gc interaction, which is the one most likely to be "fixed"
   * into incorrectness later. gc's scope is the current live state, so an
   * object it removed from S3 survives here on purpose -- `extra`, not
   * `missing`, and not a failure.
   */
  it("keeps what gc removed, counts it as extra, and prunes it only when asked", async () => {
    const { root, mirror } = await vaultWithMirror(2);

    fs.rmSync(path.join(root, "file-0.txt"));
    await runCli(["update_cache", "--root", root, "--json"]);
    await runCli(["sync", "--root", root, "--json"], { env });
    const collected = await runCli(["gc", "--apply", "--root", root, "--json"], { env });
    expect(collected.exitCode).toBe(0);

    const afterGc = await runCli(["mirror", "verify", "--root", root, "--json"], { env });
    const afterGcJson = JSON.parse(afterGc.stdout) as VerifyJson;
    // Still a healthy mirror. gc mirrored its own snapshot, so the drive's
    // `current` now names a version that no longer references the deleted
    // object -- which makes the file surplus rather than missing. That is
    // the safety net working: gc's scope is S3, and the mirror keeps what
    // it removed until someone asks otherwise.
    expect(afterGcJson).toMatchObject({ ok: true, missing: 0, extra: 1 });
    expect(afterGc.exitCode).toBe(0);

    const dryRun = await runCli(["mirror", "prune", "--root", root, "--json"], { env });
    expect(JSON.parse(dryRun.stdout) as { pruned: number; applied: boolean }).toMatchObject({
      pruned: 1,
      applied: false,
    });
    expect(mirrorObjectFiles(mirror)).toHaveLength(2);

    const applied = await runCli(["mirror", "prune", "--apply", "--root", root, "--json"], { env });
    expect(JSON.parse(applied.stdout) as { pruned: number }).toMatchObject({ pruned: 1 });
    expect(mirrorObjectFiles(mirror)).toHaveLength(1);

    const afterPrune = await runCli(["mirror", "verify", "--root", root, "--json"], { env });
    expect(JSON.parse(afterPrune.stdout) as VerifyJson).toMatchObject({ ok: true, extra: 0 });

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });

  it("errors rather than reporting a clean zero when the mirror is unreachable", async () => {
    const { root, mirror } = await vaultWithMirror(1);
    fs.rmSync(mirror, { recursive: true, force: true });

    const result = await runCli(["mirror", "verify", "--root", root, "--json"], { env });
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("does not exist or is not reachable");

    fs.rmSync(root, { recursive: true, force: true });
  });
});
