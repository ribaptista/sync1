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

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-root-"));
}

const PASSWORD = "correct horse battery staple";

describe("attach_remote", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("attaches a second machine to an existing vault, matching state.db, with no filesystem writes beyond .sync1", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);

    const machineARoot = mkTempRoot();
    const initResult = await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--prefix",
        "vault",
        "--root",
        machineARoot,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(initResult.exitCode).toBe(0);
    const initParsed = JSON.parse(initResult.stdout) as { version_stamp: string };

    const machineBRoot = mkTempRoot();
    const attachResult = await runCli(
      [
        "attach_remote",
        "--bucket",
        bucket,
        "--prefix",
        "vault",
        "--root",
        machineBRoot,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );

    expect(attachResult.stderr).toBe("");
    expect(attachResult.exitCode).toBe(0);
    const attachParsed = JSON.parse(attachResult.stdout) as { ok: boolean; version_stamp: string };
    expect(attachParsed.ok).toBe(true);
    expect(attachParsed.version_stamp).toBe(initParsed.version_stamp);

    // local .sync1/ layout on machine B
    expect(fs.existsSync(path.join(machineBRoot, ".sync1", "state.db"))).toBe(true);
    expect(fs.existsSync(path.join(machineBRoot, ".sync1", "cache.db"))).toBe(true);
    expect(fs.existsSync(path.join(machineBRoot, ".sync1", "vault.json"))).toBe(true);
    expect(fs.readFileSync(path.join(machineBRoot, ".sync1", "last_synced_version"), "utf8")).toBe(
      initParsed.version_stamp,
    );

    // decrypted state.db matches machine A's: same version row
    const dbA = new Database(path.join(machineARoot, ".sync1", "state.db"), { readonly: true });
    const dbB = new Database(path.join(machineBRoot, ".sync1", "state.db"), { readonly: true });
    const versionsA = dbA.prepare("SELECT version_stamp FROM versions").all();
    const versionsB = dbB.prepare("SELECT version_stamp FROM versions").all();
    expect(versionsB).toEqual(versionsA);
    dbA.close();
    dbB.close();

    // no filesystem writes beyond .sync1/ itself — attach_remote never
    // materializes the tree, that's sync's job
    const rootEntries = fs.readdirSync(machineBRoot);
    expect(rootEntries).toEqual([".sync1"]);

    fs.rmSync(machineARoot, { recursive: true, force: true });
    fs.rmSync(machineBRoot, { recursive: true, force: true });
  });

  it("rejects a wrong password before writing anything locally", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);

    const machineARoot = mkTempRoot();
    const initResult = await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        machineARoot,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(initResult.exitCode).toBe(0);

    const machineBRoot = mkTempRoot();
    const attachResult = await runCli(
      [
        "attach_remote",
        "--bucket",
        bucket,
        "--root",
        machineBRoot,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: "totally wrong password" } },
    );

    expect(attachResult.exitCode).not.toBe(0);
    const parsed = JSON.parse(attachResult.stdout) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/incorrect password/);
    // A failed attempt may leave a bare .sync1/ behind (it's created early,
    // to hold the per-vault lock before any network work) -- but never
    // vault.json, which is only written near the very end of success. A
    // retry against the same root, with the correct password this time,
    // must still succeed.
    expect(fs.existsSync(path.join(machineBRoot, ".sync1", "vault.json"))).toBe(false);

    const retryResult = await runCli(
      [
        "attach_remote",
        "--bucket",
        bucket,
        "--root",
        machineBRoot,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(retryResult.exitCode).toBe(0);
    expect(fs.existsSync(path.join(machineBRoot, ".sync1", "vault.json"))).toBe(true);

    fs.rmSync(machineARoot, { recursive: true, force: true });
    fs.rmSync(machineBRoot, { recursive: true, force: true });
  });

  it("fails cleanly when no vault exists at the given location", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();

    const result = await runCli(
      [
        "attach_remote",
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

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; error: string };
    expect(parsed.error).toMatch(/no vault found/);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
