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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-bidir-"));
}

async function sync(root: string) {
  const result = await runCli(["sync", "--root", root, "--json"], {
    env: { SYNC1_PASSWORD: PASSWORD },
  });
  return { ...result, parsed: JSON.parse(result.stdout) as Record<string, unknown> };
}

function cacheRowState(
  root: string,
  filePath: string,
): { state: string; parent_state_version: string } | undefined {
  const db = new Database(path.join(root, ".sync1", "cache.db"), { readonly: true });
  const row = db
    .prepare("SELECT state, parent_state_version FROM entries WHERE path = ?")
    .get(filePath) as { state: string; parent_state_version: string } | undefined;
  db.close();
  return row;
}

describe("sync: full bidirectional (multi-machine)", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("propagates a file created on machine A down to machine B via B's own sync", async () => {
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
    fs.writeFileSync(path.join(rootA, "from-a.txt"), "hello from A");
    const syncA = await sync(rootA);
    expect(syncA.exitCode).toBe(0);

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
    // attach_remote makes no filesystem writes -- the file only shows up
    // once B runs its own sync (B has no local changes, so this is a pure
    // catch-up: no new version committed, just adopting what's already there).
    expect(fs.existsSync(path.join(rootB, "from-a.txt"))).toBe(false);

    const syncB = await sync(rootB);
    expect(syncB.exitCode).toBe(0);
    expect(syncB.parsed.nothing_to_sync).toBe(false);
    expect(syncB.parsed.remote_created).toBe(1);
    expect(fs.readFileSync(path.join(rootB, "from-a.txt"), "utf8")).toBe("hello from A");
    expect(cacheRowState(rootB, "from-a.txt")?.state).toBe("unchanged");

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });

  it("lets concurrent edits to different files both succeed, converging on both machines", async () => {
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

    // A creates and commits first
    fs.writeFileSync(path.join(rootA, "file-a.txt"), "content A");
    const syncA1 = await sync(rootA);
    expect(syncA1.exitCode).toBe(0);

    // B, unaware of A's commit, creates its own unrelated file and syncs --
    // this must pull A's change down AND push B's change up, in one sync.
    fs.writeFileSync(path.join(rootB, "file-b.txt"), "content B");
    const syncB = await sync(rootB);
    expect(syncB.exitCode).toBe(0);
    expect(syncB.parsed.remote_created).toBe(1); // file-a.txt pulled down
    expect(syncB.parsed.local_entries_changed).toBe(1); // file-b.txt pushed up
    expect(fs.readFileSync(path.join(rootB, "file-a.txt"), "utf8")).toBe("content A");
    expect(fs.readFileSync(path.join(rootB, "file-b.txt"), "utf8")).toBe("content B");

    // A catches up on B's change with a plain sync (no local changes of its own)
    const syncA2 = await sync(rootA);
    expect(syncA2.exitCode).toBe(0);
    expect(syncA2.parsed.remote_created).toBe(1); // file-b.txt pulled down
    expect(fs.readFileSync(path.join(rootA, "file-b.txt"), "utf8")).toBe("content B");

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });

  it("reports a conflict (exit code 2) for concurrent edits to the same path, leaving the local file untouched", async () => {
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
    fs.writeFileSync(path.join(rootA, "shared.txt"), "original");
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
    await sync(rootB); // B catches up to "original"
    expect(fs.readFileSync(path.join(rootB, "shared.txt"), "utf8")).toBe("original");

    // A edits and commits first
    fs.writeFileSync(path.join(rootA, "shared.txt"), "from A");
    const syncA = await sync(rootA);
    expect(syncA.exitCode).toBe(0);

    // B edits the same file independently, unaware of A's change, then syncs
    fs.writeFileSync(path.join(rootB, "shared.txt"), "from B");
    const syncB = await sync(rootB);

    expect(syncB.exitCode).toBe(2);
    expect(syncB.parsed.ok).toBe(false);
    const conflicts = syncB.parsed.conflicts as Array<{ path: string; reason: string }>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.path).toBe("shared.txt");
    expect(conflicts[0]!.reason).toMatch(/modified both locally and remotely/);

    // B's local file is left exactly as the user wrote it -- never overwritten
    expect(fs.readFileSync(path.join(rootB, "shared.txt"), "utf8")).toBe("from B");
    // and the cache row stays dirty (unresolved), preserving its original baseline
    const row = cacheRowState(rootB, "shared.txt");
    expect(row?.state).toBe("modified");

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });

  it("self-heals when cache.db cleanup didn't run after an otherwise-successful commit", async () => {
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
    fs.writeFileSync(path.join(root, "file.txt"), "hello");
    const firstSync = await sync(root);
    expect(firstSync.exitCode).toBe(0);
    expect(cacheRowState(root, "file.txt")?.state).toBe("unchanged");

    // Simulate a crash between the successful remote commit and the local
    // cache.db reconciliation step: revert the cache row back to its
    // pre-sync dirty state, as if the process died right after the CAS
    // write landed but before reconcileCacheAfterCommit ran.
    const cacheDb = new Database(path.join(root, ".sync1", "cache.db"));
    cacheDb
      .prepare("UPDATE entries SET state = 'created', parent_state_version = 'v0' WHERE path = ?")
      .run("file.txt");
    cacheDb.close();

    const secondSync = await sync(root);
    expect(secondSync.exitCode).toBe(0);
    expect(secondSync.parsed.ok).toBe(true);
    expect((secondSync.parsed.conflicts as unknown[]).length).toBe(0);
    expect(cacheRowState(root, "file.txt")?.state).toBe("unchanged");
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("hello");

    fs.rmSync(root, { recursive: true, force: true });
  });
});
