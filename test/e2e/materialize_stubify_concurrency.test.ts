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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-mat-stub-concurrency-"));
}

interface DispatchLogLine {
  pool: string;
  inFlight: number;
  msg: string;
}

function parseDispatchLogs(stderr: string): DispatchLogLine[] {
  const lines: DispatchLogLine[] = [];
  for (const line of stderr.split("\n")) {
    if (!line.trim()) continue;
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "pool" in parsed &&
      "inFlight" in parsed &&
      "msg" in parsed
    ) {
      lines.push(parsed as DispatchLogLine);
    }
  }
  return lines;
}

function maxInFlightFor(logs: DispatchLogLine[], pool: string): number {
  const dispatches = logs.filter((l) => l.pool === pool && l.msg === "dispatched");
  return Math.max(...dispatches.map((l) => l.inFlight));
}

function readCacheSize(root: string, relativePath: string): number | null {
  const db = new Database(path.join(root, ".sync1", "cache.db"), { readonly: true });
  const row = db.prepare("SELECT size FROM entries WHERE path = ?").get(relativePath) as
    { size: number | null } | undefined;
  db.close();
  return row?.size ?? null;
}

describe("materialize/stubify: concurrency", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("materialize HEADs and downloads multiple stubs concurrently, each pool bounded by its own flag", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();
    const fileCount = 8;

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
    for (let i = 0; i < fileCount; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), `content of file ${i}`.repeat(500));
    }
    expect(
      (await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } }))
        .exitCode,
    ).toBe(0);
    expect(
      (
        await runCli(["stubify", "*", "--root", root, "--json"], {
          env: { SYNC1_PASSWORD: PASSWORD },
        })
      ).exitCode,
    ).toBe(0);
    for (let i = 0; i < fileCount; i++) {
      expect(fs.existsSync(path.join(root, `f${i}.txt`))).toBe(false);
      expect(fs.existsSync(path.join(root, `f${i}.txt.stub`))).toBe(true);
    }

    const s3Parallelism = 2;
    const streamParallelism = 3;
    const result = await runCli(
      [
        "materialize",
        "*",
        "--root",
        root,
        "--json",
        "--verbose",
        "--s3-metadata-parallelism",
        String(s3Parallelism),
        "--file-stream-parallelism",
        String(streamParallelism),
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { materialized: number };
    expect(parsed.materialized).toBe(fileCount);
    for (let i = 0; i < fileCount; i++) {
      expect(fs.existsSync(path.join(root, `f${i}.txt`))).toBe(true);
    }

    const logs = parseDispatchLogs(result.stderr);
    const s3Dispatches = logs.filter((l) => l.pool === "s3" && l.msg === "dispatched");
    expect(s3Dispatches.length).toBe(fileCount);
    expect(maxInFlightFor(logs, "s3")).toBeLessThanOrEqual(s3Parallelism);
    expect(maxInFlightFor(logs, "s3")).toBe(s3Parallelism);

    const streamDispatches = logs.filter((l) => l.pool === "stream" && l.msg === "dispatched");
    expect(streamDispatches.length).toBe(fileCount);
    expect(maxInFlightFor(logs, "stream")).toBeLessThanOrEqual(streamParallelism);
    expect(maxInFlightFor(logs, "stream")).toBe(streamParallelism);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stubify rehashes multiple mtime-changed files concurrently, bounded by --hash-parallelism", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();
    const fileCount = 8;

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
    for (let i = 0; i < fileCount; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), `content of file ${i}`.repeat(500));
    }
    expect(
      (await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } }))
        .exitCode,
    ).toBe(0);

    // Confirms cache.db's size column is already populated for every real,
    // synced file at this point -- stubify's rehash path below reads size
    // straight from the row (never falling back to a fresh fs.statSync),
    // which is only correct if this is true.
    for (let i = 0; i < fileCount; i++) {
      expect(readCacheSize(root, `f${i}.txt`)).toBe(`content of file ${i}`.repeat(500).length);
    }

    // Bump every file's mtime without changing its content -- stubify must
    // rehash each one (mtime no longer matches cache.db's baseline) before
    // confirming it's still safe to replace with a stub.
    const future = new Date(Date.now() + 60_000);
    for (let i = 0; i < fileCount; i++) {
      fs.utimesSync(path.join(root, `f${i}.txt`), future, future);
    }

    const hashParallelism = 3;
    const result = await runCli([
      "stubify",
      "*",
      "--root",
      root,
      "--json",
      "--verbose",
      "--hash-parallelism",
      String(hashParallelism),
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { stubified: number; skipped: unknown[] };
    expect(parsed.stubified).toBe(fileCount);
    expect(parsed.skipped).toEqual([]);

    const dispatchLogs = parseDispatchLogs(result.stderr).filter(
      (l) => l.pool === "hash" && l.msg === "dispatched",
    );
    expect(dispatchLogs.length).toBe(fileCount);
    const maxInFlight = Math.max(...dispatchLogs.map((l) => l.inFlight));
    expect(maxInFlight).toBeLessThanOrEqual(hashParallelism);
    expect(maxInFlight).toBe(hashParallelism);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
