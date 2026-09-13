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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-cvg-status-gc-concurrency-"));
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

describe("converge/status/gc: concurrency", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("status/converge HEAD-check multiple distinct objects concurrently, bounded by --s3-metadata-parallelism", async () => {
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
      fs.writeFileSync(path.join(root, `f${i}.txt`), `distinct content ${i}`.repeat(500));
    }
    expect(
      (await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } }))
        .exitCode,
    ).toBe(0);

    const s3Parallelism = 3;
    const result = await runCli([
      "status",
      "--root",
      root,
      "--json",
      "--verbose",
      "--s3-metadata-parallelism",
      String(s3Parallelism),
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { already_correct: number };
    expect(parsed.already_correct).toBe(fileCount);

    const dispatchLogs = parseDispatchLogs(result.stderr).filter(
      (l) => l.pool === "s3" && l.msg === "dispatched",
    );
    expect(dispatchLogs.length).toBe(fileCount);
    const maxInFlight = Math.max(...dispatchLogs.map((l) => l.inFlight));
    expect(maxInFlight).toBeLessThanOrEqual(s3Parallelism);
    expect(maxInFlight).toBe(s3Parallelism);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("gc --apply deletes multiple orphaned objects concurrently, bounded by --s3-metadata-parallelism", async () => {
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
      fs.writeFileSync(path.join(root, `f${i}.txt`), `distinct content ${i}`.repeat(500));
    }
    expect(
      (await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } }))
        .exitCode,
    ).toBe(0);

    for (let i = 0; i < fileCount; i++) {
      fs.rmSync(path.join(root, `f${i}.txt`));
    }
    expect(
      (await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } }))
        .exitCode,
    ).toBe(0);

    const s3Parallelism = 3;
    const result = await runCli(
      [
        "gc",
        "--root",
        root,
        "--apply",
        "--json",
        "--verbose",
        "--s3-metadata-parallelism",
        String(s3Parallelism),
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { applied: boolean; orphan_count: number };
    expect(parsed.applied).toBe(true);
    expect(parsed.orphan_count).toBe(fileCount);

    const dispatchLogs = parseDispatchLogs(result.stderr).filter(
      (l) => l.pool === "s3" && l.msg === "dispatched",
    );
    expect(dispatchLogs.length).toBe(fileCount);
    const maxInFlight = Math.max(...dispatchLogs.map((l) => l.inFlight));
    expect(maxInFlight).toBeLessThanOrEqual(s3Parallelism);
    expect(maxInFlight).toBe(s3Parallelism);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
