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

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-inspect-"));
}

interface InspectRow {
  path: string;
  cache: { hash: string | null; mtime: number | null; state: string } | null;
  state: {
    hash: string | null;
    state_version: string;
    sequence: number | null;
    size: number | null;
  } | null;
}

function parseJsonl(stdout: string): InspectRow[] {
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as InspectRow);
}

describe("inspect", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("returns populated cache+state for a known path", async () => {
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
    fs.writeFileSync(path.join(root, "a.txt"), "hello");
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    const result = await runCli(["inspect", "a.txt", "--root", root, "--json"]);
    expect(result.exitCode).toBe(0);
    const rows = parseJsonl(result.stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe("a.txt");
    expect(rows[0]!.cache).toMatchObject({ state: "unchanged" });
    expect(rows[0]!.cache!.hash).toHaveLength(64);
    expect(rows[0]!.state).toMatchObject({ sequence: 2, size: 5 }); // v0 (init) + v1 (this sync)
    expect(rows[0]!.state!.hash).toBe(rows[0]!.cache!.hash);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns nulls for an untracked exact path, no error", async () => {
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

    const result = await runCli(["inspect", "never-existed.txt", "--root", root, "--json"]);
    expect(result.exitCode).toBe(0);
    const rows = parseJsonl(result.stdout);
    expect(rows).toEqual([{ path: "never-existed.txt", cache: null, state: null }]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns one JSONL line per glob match", async () => {
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
    fs.mkdirSync(path.join(root, "photos"));
    fs.writeFileSync(path.join(root, "photos", "a.jpg"), "a");
    fs.writeFileSync(path.join(root, "photos", "b.jpg"), "b");
    fs.writeFileSync(path.join(root, "other.txt"), "c");
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    const result = await runCli(["inspect", "photos/*", "--root", root, "--json"]);
    expect(result.exitCode).toBe(0);
    const rows = parseJsonl(result.stdout);
    expect(rows.map((r) => r.path)).toEqual(["photos/a.jpg", "photos/b.jpg"]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("never includes crypto internals (s3_key, nonce) in its output", async () => {
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
    fs.writeFileSync(path.join(root, "a.txt"), "hello");
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    const result = await runCli(["inspect", "a.txt", "--root", root, "--json"]);
    expect(result.stdout).not.toMatch(/s3_key/);
    expect(result.stdout).not.toMatch(/nonce/);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
