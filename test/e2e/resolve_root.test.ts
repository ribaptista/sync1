import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runCli } from "./helpers/cli.js";
import { openStateDb } from "../../src/db/connection.js";
import { VersionsRepository } from "../../src/db/repositories/versions-repository.js";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";

const PASSWORD = "correct horse battery staple";

/** A minimal, valid .sync1/ -- same recipe update_cache's own e2e suite
 * uses -- for the commands here that need no S3 access at all. */
function mkVaultRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-resolve-root-"));
  fs.mkdirSync(path.join(root, ".sync1"));
  fs.writeFileSync(path.join(root, ".sync1", "last_synced_version"), "v0", "utf8");
  const stateDb = openStateDb(path.join(root, ".sync1", "state.db"));
  new VersionsRepository(stateDb).insert("v0", new Date().toISOString());
  stateDb.close();
  return root;
}

function mkEmptyDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-resolve-root-empty-"));
}

function readCacheTrackedPaths(root: string): string[] {
  const db = new Database(path.join(root, ".sync1", "cache.db"), { readonly: true });
  const rows = db.prepare<[], { path: string }>("SELECT path FROM entries ORDER BY path").all();
  db.close();
  return rows.map((r) => r.path);
}

describe("--root defaults to the nearest ancestor .sync1/ when omitted", () => {
  it("finds the vault when cwd is the vault root itself", async () => {
    const root = mkVaultRoot();
    fs.writeFileSync(path.join(root, "a.txt"), "hello");

    const result = await runCli(["update_cache", "--json"], { cwd: root });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; created: number };
    expect(parsed).toMatchObject({ ok: true, created: 1 });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds the vault when cwd is a nested subdirectory of the vault root", async () => {
    const root = mkVaultRoot();
    fs.writeFileSync(path.join(root, "a.txt"), "hello");
    const nested = path.join(root, "Photos", "2024");
    fs.mkdirSync(nested, { recursive: true });

    const result = await runCli(["update_cache", "--json"], { cwd: nested });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; created: number };
    // The scan walks the whole vault from the resolved root, not just cwd
    // -- a.txt plus the two directory levels (Photos, Photos/2024) all get
    // created, which is itself proof resolveRoot found the real root and
    // not "nested" (a walk rooted at "nested" would see none of these).
    expect(parsed).toMatchObject({ ok: true, created: 3 });
    expect(readCacheTrackedPaths(root)).toEqual(["Photos", "Photos/2024", "a.txt"]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("an explicit --root still works exactly as before, regardless of cwd", async () => {
    const root = mkVaultRoot();
    fs.writeFileSync(path.join(root, "a.txt"), "hello");
    const elsewhere = mkEmptyDir();

    const result = await runCli(["update_cache", "--root", root, "--json"], { cwd: elsewhere });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; created: number };
    expect(parsed).toMatchObject({ ok: true, created: 1 });

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it("fails cleanly with a clear error when --root is omitted and no ancestor has .sync1/", async () => {
    const bare = mkEmptyDir();

    const result = await runCli(["update_cache", "--json"], { cwd: bare });
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/no ".sync1" vault found/);

    fs.rmSync(bare, { recursive: true, force: true });
  });

  it("stops at the nearest ancestor vault, not an outer one, for a vault nested inside another", async () => {
    const outer = mkVaultRoot();
    const inner = path.join(outer, "inner-vault");
    fs.mkdirSync(inner);
    fs.mkdirSync(path.join(inner, ".sync1"));
    fs.writeFileSync(path.join(inner, ".sync1", "last_synced_version"), "v0", "utf8");
    const innerStateDb = openStateDb(path.join(inner, ".sync1", "state.db"));
    new VersionsRepository(innerStateDb).insert("v0", new Date().toISOString());
    innerStateDb.close();
    fs.writeFileSync(path.join(inner, "b.txt"), "world");

    const result = await runCli(["update_cache", "--json"], { cwd: inner });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; created: number };
    expect(parsed).toMatchObject({ ok: true, created: 1 });
    // The tracked path itself is the real proof: "b.txt" (relative to
    // inner/) only if resolveRoot actually stopped at the nearer vault --
    // "inner-vault/b.txt" would mean it wrongly walked from outer/ instead,
    // a mistake the created:1 count alone wouldn't have caught (either
    // root produces exactly one tracked file here).
    expect(readCacheTrackedPaths(inner)).toEqual(["b.txt"]);

    fs.rmSync(outer, { recursive: true, force: true });
  });

  it("also works for a subcommand-style command (thumbnail_policy list)", async () => {
    const root = mkVaultRoot();

    const result = await runCli(["thumbnail_policy", "list", "--json"], { cwd: root });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; policies: unknown[] };
    expect(parsed).toMatchObject({ ok: true, policies: [] });

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("init_remote/attach_remote: --root defaults to the current directory, never an ancestor search", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("init_remote creates .sync1/ in cwd when --root is omitted", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const dir = mkEmptyDir();

    const result = await runCli(
      ["init_remote", "--bucket", bucket, "--endpoint", localstack.endpoint, "--json"],
      { cwd: dir, env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; root: string };
    expect(parsed.ok).toBe(true);
    expect(fs.realpathSync(parsed.root)).toBe(fs.realpathSync(dir));
    expect(fs.existsSync(path.join(dir, ".sync1"))).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("init_remote never searches ancestors for an existing .sync1/ when --root is omitted", async () => {
    // A vault already exists at outer/ -- if init_remote's --root default
    // did an ancestor search (like every other command's does), it would
    // wrongly resolve to outer/ instead of the empty inner/ directory the
    // command was actually run from.
    const outer = mkVaultRoot();
    const inner = path.join(outer, "empty-inner");
    fs.mkdirSync(inner);

    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);

    const result = await runCli(
      ["init_remote", "--bucket", bucket, "--endpoint", localstack.endpoint, "--json"],
      { cwd: inner, env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; root: string };
    expect(fs.realpathSync(parsed.root)).toBe(fs.realpathSync(inner));
    expect(fs.existsSync(path.join(inner, ".sync1"))).toBe(true);

    fs.rmSync(outer, { recursive: true, force: true });
  });
});
