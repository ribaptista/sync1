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

/**
 * Regression coverage for false "was deleted locally, but modified remotely"
 * conflicts caused by version-stamp drift.
 *
 * cache.db's per-row `parent_state_version` is compared against
 * `entries.state_version` for the *same path* (src/sync/conflict-rules.ts),
 * so it has to mirror that path's own row in the vault. It used to be
 * written from commit-level stamps instead -- the run's
 * `last_synced_version`, or the version currently being committed -- which
 * coincide with the per-path value only for as long as `sync` is the only
 * thing minting versions. Policy mutations mint versions without ever
 * touching `entries`, and a sync can pull a path down during a commit that
 * didn't write that path, so the two drifted apart routinely and every
 * subsequently deleted or modified path was compared against a baseline
 * that had nothing to do with it.
 */
function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-drift-"));
}

async function sync(root: string) {
  const result = await runCli(["sync", "--root", root, "--json"], {
    env: { SYNC1_PASSWORD: PASSWORD },
  });
  return { ...result, parsed: JSON.parse(result.stdout) as Record<string, unknown> };
}

async function initRemote(root: string, bucket: string, endpoint: string) {
  return runCli(
    ["init_remote", "--bucket", bucket, "--root", root, "--endpoint", endpoint, "--json"],
    { env: { SYNC1_PASSWORD: PASSWORD } },
  );
}

async function attachRemote(root: string, bucket: string, endpoint: string) {
  return runCli(
    ["attach_remote", "--bucket", bucket, "--root", root, "--endpoint", endpoint, "--json"],
    { env: { SYNC1_PASSWORD: PASSWORD } },
  );
}

/** Reads the committed vault row for a path straight out of the local state.db. */
function stateEntry(root: string, filePath: string): { state_version: string } | undefined {
  const db = new Database(path.join(root, ".sync1", "state.db"), { readonly: true });
  const row = db.prepare("SELECT state_version FROM entries WHERE path = ?").get(filePath) as
    { state_version: string } | undefined;
  db.close();
  return row;
}

function conflictsOf(parsed: Record<string, unknown>): Array<{ path: string; reason: string }> {
  return parsed.conflicts as Array<{ path: string; reason: string }>;
}

describe("sync: version-stamp drift must not fake a conflict", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("applies a local delete cleanly after a policy mutation moved the global version on", async () => {
    // The originally reported bug, on a single machine: nothing remote ever
    // touched these paths, yet every deletion came back as a conflict.
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();

    await initRemote(root, bucket, localstack.endpoint);
    fs.writeFileSync(path.join(root, "photo.jpg"), "picture bytes");
    const firstSync = await sync(root);
    expect(firstSync.exitCode).toBe(0);
    const committedVersion = stateEntry(root, "photo.jpg")?.state_version;
    expect(committedVersion).toBeTruthy();

    // Two policy mutations, each a real commit minting a new version and
    // advancing this machine's `last_synced_version` -- while photo.jpg's
    // own entry row is never rewritten and stays at `committedVersion`.
    // The glob deliberately matches nothing, so the file itself is
    // unaffected: only the version numbering moves.
    const create = await runCli(["ignore", "create", "*.nomatch", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(create.exitCode).toBe(0);
    const policyId = (JSON.parse(create.stdout) as { id: number }).id;
    const del = await runCli(["ignore", "delete", String(policyId), "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(del.exitCode).toBe(0);

    // The premise of the whole test: the global pointer has moved on, but
    // the vault row for this path has not.
    const globalVersion = fs
      .readFileSync(path.join(root, ".sync1", "last_synced_version"), "utf8")
      .trim();
    expect(globalVersion).not.toBe(committedVersion);
    expect(stateEntry(root, "photo.jpg")?.state_version).toBe(committedVersion);

    fs.rmSync(path.join(root, "photo.jpg"));
    const deleteSync = await sync(root);

    expect(conflictsOf(deleteSync.parsed)).toEqual([]);
    expect(deleteSync.exitCode).toBe(0);
    expect(deleteSync.parsed.ok).toBe(true);
    // ...and the deletion genuinely committed, rather than being silently dropped.
    expect(stateEntry(root, "photo.jpg")).toBeUndefined();

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("applies a local delete cleanly for a path pulled down during an unrelated commit", async () => {
    // The multi-machine route to the same drift, with no policy edit
    // involved: A pulls B's change down in the same run that commits a
    // change of A's own, so the path's cache row used to be stamped with
    // A's commit while its vault row still carries B's.
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const rootA = mkTempRoot();
    const rootB = mkTempRoot();

    await initRemote(rootA, bucket, localstack.endpoint);
    fs.writeFileSync(path.join(rootA, "shared.txt"), "original");
    expect((await sync(rootA)).exitCode).toBe(0);

    await attachRemote(rootB, bucket, localstack.endpoint);
    expect((await sync(rootB)).exitCode).toBe(0); // B picks shared.txt up as a stub
    expect(
      (
        await runCli(["materialize", "shared.txt", "--root", rootB, "--json"], {
          env: { SYNC1_PASSWORD: PASSWORD },
        })
      ).exitCode,
    ).toBe(0);

    // B edits and commits. This is the version shared.txt's vault row ends up at.
    fs.writeFileSync(path.join(rootB, "shared.txt"), "edited by B");
    const syncB = await sync(rootB);
    expect(syncB.exitCode).toBe(0);
    const versionFromB = syncB.parsed.version_stamp as string;

    // A syncs with a local change of its own, so this run both commits a new
    // version (for a-only.txt) and pulls B's shared.txt down.
    fs.writeFileSync(path.join(rootA, "a-only.txt"), "A's own file");
    const syncA = await sync(rootA);
    expect(syncA.exitCode).toBe(0);
    expect(syncA.parsed.remote_modified).toBe(1);
    expect(fs.readFileSync(path.join(rootA, "shared.txt"), "utf8")).toBe("edited by B");
    // A committed its own version, but shared.txt's row is still B's.
    expect(syncA.parsed.version_stamp).not.toBe(versionFromB);
    expect(stateEntry(rootA, "shared.txt")?.state_version).toBe(versionFromB);

    fs.rmSync(path.join(rootA, "shared.txt"));
    const deleteSync = await sync(rootA);

    expect(conflictsOf(deleteSync.parsed)).toEqual([]);
    expect(deleteSync.exitCode).toBe(0);
    expect(stateEntry(rootA, "shared.txt")).toBeUndefined();

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });

  it("still reports a genuine delete-locally vs modified-remotely conflict", async () => {
    // The guard against buying the two cases above by loosening conflict
    // detection: here the remote really did move under A's feet.
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const rootA = mkTempRoot();
    const rootB = mkTempRoot();

    await initRemote(rootA, bucket, localstack.endpoint);
    fs.writeFileSync(path.join(rootA, "shared.txt"), "original");
    expect((await sync(rootA)).exitCode).toBe(0);

    await attachRemote(rootB, bucket, localstack.endpoint);
    expect((await sync(rootB)).exitCode).toBe(0);
    expect(
      (
        await runCli(["materialize", "shared.txt", "--root", rootB, "--json"], {
          env: { SYNC1_PASSWORD: PASSWORD },
        })
      ).exitCode,
    ).toBe(0);

    // B edits and commits. A never syncs, so it never learns about it.
    fs.writeFileSync(path.join(rootB, "shared.txt"), "edited by B");
    expect((await sync(rootB)).exitCode).toBe(0);

    fs.rmSync(path.join(rootA, "shared.txt"));
    const deleteSync = await sync(rootA);

    expect(deleteSync.exitCode).toBe(2);
    expect(deleteSync.parsed.ok).toBe(false);
    const conflicts = conflictsOf(deleteSync.parsed);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.path).toBe("shared.txt");
    expect(conflicts[0]!.reason).toMatch(/deleted locally, but modified remotely/);
    // The entry survives untouched -- a human has to resolve this.
    expect(stateEntry(rootA, "shared.txt")).toBeDefined();

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });
});
