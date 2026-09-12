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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-fetch-"));
}

describe("fetch_remote", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("pulls the latest state.db with no filesystem or cache.db changes", async () => {
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
    fs.writeFileSync(path.join(rootA, "a.txt"), "hello");
    await runCli(["sync", "--root", rootA, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

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

    // record cache.db/filesystem state before fetch_remote
    const beforeEntries = fs.readdirSync(rootB);
    const cacheDbBefore = fs.readFileSync(path.join(rootB, ".sync1", "cache.db"));

    const result = await runCli(["fetch_remote", "--root", rootB, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; version_stamp: string };
    expect(parsed.ok).toBe(true);

    // no filesystem changes beyond .sync1/state.db itself
    expect(fs.readdirSync(rootB)).toEqual(beforeEntries);
    expect(fs.readFileSync(path.join(rootB, ".sync1", "cache.db")).equals(cacheDbBefore)).toBe(
      true,
    );

    // local state.db now has the entry a.txt, fetched from remote
    const stateDb = new Database(path.join(rootB, ".sync1", "state.db"), { readonly: true });
    const rows = stateDb.prepare("SELECT path FROM entries").all() as Array<{ path: string }>;
    expect(rows.map((r) => r.path)).toEqual(["a.txt"]);
    stateDb.close();

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });

  it("rejects a wrong password without writing anything", async () => {
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
    const before = fs.readFileSync(path.join(root, ".sync1", "state.db"));

    const result = await runCli(["fetch_remote", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: "wrong password" },
    });
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; error: string };
    expect(parsed.error).toMatch(/incorrect password/);
    expect(fs.readFileSync(path.join(root, ".sync1", "state.db")).equals(before)).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
