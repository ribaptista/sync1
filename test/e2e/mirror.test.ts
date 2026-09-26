import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";

const PASSWORD = "correct horse battery staple";

function mkTemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sync1-e2e-${prefix}-`));
}

/** Every file under `dir`, as paths relative to it, with "/" separators. */
function walkRelative(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(dir)) visit(dir);
  return out.sort();
}

function setMirrorPath(root: string, mirrorPath: string | undefined): void {
  const configPath = path.join(root, ".sync1", "remote.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  if (mirrorPath === undefined) delete config.mirror_path;
  else config.mirror_path = mirrorPath;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

async function bucketKeys(
  s3: ReturnType<typeof createTestS3Client>,
  bucket: string,
): Promise<string[]> {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  return (listed.Contents ?? []).map((o) => o.Key!).sort();
}

/**
 * The mirror's whole value rests on one claim: the drive holds the same
 * encrypted bytes S3 does, at the same paths. These tests assert that
 * directly rather than trusting the write path -- key-for-key against the
 * bucket, and byte-for-byte for the objects themselves.
 */
describe("local mirror", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  async function initVault(root: string, bucket: string): Promise<void> {
    const result = await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        // A non-empty prefix on purpose: inside the bucket it lets several
        // vaults share one, and the mirror must NOT reproduce it -- a
        // mirror directory is already the vault's own.
        "--prefix",
        "v0",
        "--root",
        root,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(result.exitCode).toBe(0);
  }

  it("writes the same keys and the same bytes the bucket holds", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTemp("mirror-root");
    const mirror = mkTemp("mirror-drive");

    await initVault(root, bucket);
    setMirrorPath(root, mirror);

    fs.mkdirSync(path.join(root, "photos"));
    fs.writeFileSync(path.join(root, "photos", "a.txt"), "first file");
    fs.writeFileSync(path.join(root, "photos", "b.txt"), "second file");
    await runCli(["update_cache", "--root", root, "--json"]);

    const synced = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(synced.exitCode).toBe(0);
    const summary = JSON.parse(synced.stdout) as {
      uploaded_objects: number;
      mirrored_objects: number;
      mirror_failures: number;
    };
    expect(summary.uploaded_objects).toBe(2);
    expect(summary.mirrored_objects).toBe(2);
    expect(summary.mirror_failures).toBe(0);

    // Every mirrored path exists in the bucket at the same key, prefix
    // stripped. A subset rather than an equality: `init_remote` committed
    // a snapshot before `mirror_path` was configured, so S3 legitimately
    // holds history the drive never saw -- which is exactly the gap
    // `mirror catchup` exists to close, not a defect here.
    const prefix = "v0/";
    const remoteKeys = (await bucketKeys(s3, bucket))
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
    const mirrorKeys = walkRelative(mirror);
    expect(mirrorKeys.length).toBeGreaterThan(0);
    for (const key of mirrorKeys) expect(remoteKeys).toContain(key);

    // Objects specifically must match exactly: those are the bytes the
    // whole exercise is about, and none may be missing.
    const remoteObjects = remoteKeys.filter((k) => k.startsWith("objects/"));
    expect(mirrorKeys.filter((k) => k.startsWith("objects/"))).toEqual(remoteObjects);

    // Byte-for-byte, for every content object. Convergent encryption is
    // what makes this hold -- and it is the claim that lets the mirror be
    // served straight back as a restore source.
    for (const key of remoteObjects) {
      const remote = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + key }));
      const remoteBytes = Buffer.from(await remote.Body!.transformToByteArray());
      const localBytes = fs.readFileSync(path.join(mirror, ...key.split("/")));
      expect(localBytes.equals(remoteBytes)).toBe(true);
    }

    // vault.json is the one file whose absence makes the rest worthless.
    expect(fs.existsSync(path.join(mirror, "vault.json"))).toBe(true);
    expect(fs.readFileSync(path.join(mirror, "current"), "utf8")).toBe(summaryVersion(synced));

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });

  /**
   * The defect the per-sink split exists to prevent. Mirroring hung off the
   * upload path alone would silently skip every object that took a dedup
   * shortcut -- and from sync's point of view those rows succeeded, so
   * nothing would ever report the hole.
   */
  it("fills a gap for content S3 already has, without re-uploading it", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTemp("mirror-root");
    const mirror = mkTemp("mirror-drive");

    await initVault(root, bucket);

    // First sync with no mirror at all: S3 gets the object, the drive
    // never hears about it. Exactly the state of a vault that adopts a
    // mirror after it has already been syncing.
    fs.writeFileSync(path.join(root, "a.txt"), "content that predates the mirror");
    await runCli(["update_cache", "--root", root, "--json"]);
    const first = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect((JSON.parse(first.stdout) as { uploaded_objects: number }).uploaded_objects).toBe(1);

    // Now configure the mirror and make a *different* file dirty. The
    // existing object is a dedup hit for S3 but a miss for the mirror.
    setMirrorPath(root, mirror);
    fs.writeFileSync(path.join(root, "b.txt"), "content that predates the mirror");
    await runCli(["update_cache", "--root", root, "--json"]);
    const second = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    const summary = JSON.parse(second.stdout) as {
      uploaded_objects: number;
      deduped_objects: number;
      mirrored_objects: number;
    };

    // No bytes went to S3 -- it already had this content -- but the mirror
    // got its copy anyway.
    expect(summary.uploaded_objects).toBe(0);
    expect(summary.deduped_objects).toBe(1);
    expect(summary.mirrored_objects).toBe(1);
    expect(walkRelative(mirror).filter((k) => k.startsWith("objects/"))).toHaveLength(1);

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });

  /**
   * Policy edits mint version stamps through `mutateStateDb`, not through
   * `commit.ts`. Without its own hook, every ignore/storage/thumbnail
   * policy change would be a snapshot the mirror never received -- and
   * "every snapshot, forever" would quietly mean "every snapshot a sync
   * happened to make".
   */
  it("mirrors the snapshot a policy edit commits, not just sync's", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTemp("mirror-root");
    const mirror = mkTemp("mirror-drive");

    await initVault(root, bucket);
    setMirrorPath(root, mirror);

    const created = await runCli(["ignore", "create", "scratch/**", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(created.exitCode).toBe(0);

    const prefix = "v0/";
    // The edit's own snapshot, not init_remote's -- the mirror was
    // configured after the vault existed, so it holds exactly the one
    // version this policy change minted.
    const editStamp = (JSON.parse(created.stdout) as { version_stamp: string }).version_stamp;
    const remoteStates = (await bucketKeys(s3, bucket))
      .filter((k) => k.startsWith(`${prefix}states/`))
      .map((k) => k.slice(prefix.length));
    expect(remoteStates).toContain(`states/${editStamp}`);
    expect(walkRelative(mirror).filter((k) => k.startsWith("states/"))).toEqual([
      `states/${editStamp}`,
    ]);
    expect(fs.readFileSync(path.join(mirror, "current"), "utf8")).toBe(editStamp);

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });

  it("--skip-mirror leaves the drive untouched while the sync still commits", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTemp("mirror-root");
    const mirror = mkTemp("mirror-drive");

    await initVault(root, bucket);
    setMirrorPath(root, mirror);

    fs.writeFileSync(path.join(root, "a.txt"), "not going to the mirror this run");
    await runCli(["update_cache", "--root", root, "--json"]);
    const synced = await runCli(["sync", "--root", root, "--skip-mirror", "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });

    const summary = JSON.parse(synced.stdout) as {
      ok: boolean;
      uploaded_objects: number;
      mirrored_objects: number;
    };
    expect(summary.ok).toBe(true);
    expect(summary.uploaded_objects).toBe(1);
    expect(summary.mirrored_objects).toBe(0);
    expect(walkRelative(mirror)).toEqual([]);

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });

  /**
   * A mirror inside the tracked tree would be walked as ordinary content
   * and back itself up, one generation per sync, growing without bound.
   * Rejected at resolution rather than discovered as runaway disk use.
   */
  it("refuses a mirror_path inside the vault root", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTemp("mirror-root");

    await initVault(root, bucket);
    setMirrorPath(root, path.join(root, "inside-the-tree"));

    fs.writeFileSync(path.join(root, "a.txt"), "anything");
    await runCli(["update_cache", "--root", root, "--json"]);
    const synced = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });

    expect(synced.exitCode).not.toBe(0);
    expect(JSON.parse(synced.stdout) as { ok: boolean; error: string }).toMatchObject({
      ok: false,
      error: expect.stringContaining("inside the vault root") as string,
    });

    fs.rmSync(root, { recursive: true, force: true });
  });
});

function summaryVersion(result: { stdout: string }): string {
  return (JSON.parse(result.stdout) as { version_stamp: string }).version_stamp;
}
