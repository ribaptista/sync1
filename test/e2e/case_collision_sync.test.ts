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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-case-sync-"));
}

async function sync(root: string) {
  const result = await runCli(["sync", "--root", root, "--json"], {
    env: { SYNC1_PASSWORD: PASSWORD },
  });
  return { ...result, parsed: JSON.parse(result.stdout) as Record<string, unknown> };
}

function cacheRowState(root: string, filePath: string): string | undefined {
  const db = new Database(path.join(root, ".sync1", "cache.db"), { readonly: true });
  const row = db.prepare("SELECT state FROM entries WHERE path = ?").get(filePath) as
    { state: string } | undefined;
  db.close();
  return row?.state;
}

describe("sync-time case-insensitive collision (two machines)", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("reports the collision as a conflict, leaves B's row dirty, does not corrupt the shared vault", async () => {
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
    // B attaches before A's commit exists, so B never fetches it
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

    fs.writeFileSync(path.join(rootA, "photo.jpg"), "from A");
    const syncA = await sync(rootA);
    expect(syncA.exitCode).toBe(0);

    // B independently creates a case-variant path, without ever fetching A's commit
    fs.writeFileSync(path.join(rootB, "Photo.jpg"), "from B");
    const syncB = await sync(rootB);

    expect(syncB.exitCode).toBe(2); // EXIT_CONFLICT
    const conflicts = syncB.parsed.conflicts as Array<{ path: string; reason: string }>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.path).toBe("Photo.jpg");
    expect(conflicts[0]?.reason).toMatch(/case-insensitive collision/);

    // left dirty, not silently dropped or corrupted into the shared vault
    expect(cacheRowState(rootB, "Photo.jpg")).toBe("created");

    const stateDb = new Database(path.join(rootA, ".sync1", "state.db"), { readonly: true });
    const paths = stateDb.prepare("SELECT path FROM entries").all() as Array<{ path: string }>;
    stateDb.close();
    expect(paths.map((r) => r.path)).toEqual(["photo.jpg"]); // B's variant never landed

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });

  it("still commits an unrelated local change in the same run", async () => {
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

    fs.writeFileSync(path.join(rootA, "photo.jpg"), "from A");
    await sync(rootA);

    fs.writeFileSync(path.join(rootB, "Photo.jpg"), "from B"); // will collide
    fs.writeFileSync(path.join(rootB, "notes.txt"), "unrelated"); // should still commit
    const syncB = await sync(rootB);

    expect(syncB.exitCode).toBe(2);
    expect(cacheRowState(rootB, "Photo.jpg")).toBe("created"); // still dirty
    expect(cacheRowState(rootB, "notes.txt")).toBe("unchanged"); // committed normally

    const stateDb = new Database(path.join(rootB, ".sync1", "state.db"), { readonly: true });
    const paths = stateDb.prepare("SELECT path FROM entries").all() as Array<{ path: string }>;
    stateDb.close();
    expect(paths.map((r) => r.path).sort()).toEqual(["notes.txt", "photo.jpg"]);

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });

  it("propagates a remote rename to a second machine with no error", async () => {
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
    fs.writeFileSync(path.join(rootA, "file.txt"), "content");
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
    await sync(rootB); // B materializes as a stub by default
    await runCli(["materialize", "file.txt", "--root", rootB, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(fs.readFileSync(path.join(rootB, "file.txt"), "utf8")).toBe("content");

    // A renames (per Task A3a/B3, this always resolves as delete+create)
    fs.renameSync(path.join(rootA, "file.txt"), path.join(rootA, "FILE.txt"));
    const syncA = await sync(rootA);
    expect(syncA.exitCode).toBe(0);

    const syncB = await sync(rootB);
    expect(syncB.exitCode).toBe(0);

    expect(fs.existsSync(path.join(rootB, "file.txt"))).toBe(false);
    // new name arrives as a stub (never materialized before), per the
    // existing attach_remote/sync default
    expect(fs.existsSync(path.join(rootB, "FILE.txt.stub"))).toBe(true);

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });
});
