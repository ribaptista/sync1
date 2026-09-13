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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-sanity-concurrency-"));
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

describe("sanity_check: concurrency", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("hashes and HEADs multiple tracked files concurrently, each bounded by its own --*-parallelism flag", async () => {
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

    const fileCount = 10;
    for (let i = 0; i < fileCount; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), `content of file ${i}`.repeat(500));
    }
    const syncResult = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(syncResult.exitCode).toBe(0);

    const hashParallelism = 3;
    const s3Parallelism = 2;
    const result = await runCli([
      "sanity_check",
      "--root",
      root,
      "--json",
      "--verbose",
      "--hash-parallelism",
      String(hashParallelism),
      "--s3-metadata-parallelism",
      String(s3Parallelism),
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    const dispatchLogs = parseDispatchLogs(result.stderr);

    const hashDispatches = dispatchLogs.filter((l) => l.pool === "hash" && l.msg === "dispatched");
    expect(hashDispatches.length).toBe(fileCount);
    const maxHashInFlight = Math.max(...hashDispatches.map((l) => l.inFlight));
    expect(maxHashInFlight).toBeLessThanOrEqual(hashParallelism);
    expect(maxHashInFlight).toBe(hashParallelism);

    const s3Dispatches = dispatchLogs.filter((l) => l.pool === "s3" && l.msg === "dispatched");
    expect(s3Dispatches.length).toBe(fileCount);
    // s3Pool's occupancy is read as `pending` (running) at dispatch time --
    // never exceeds the configured concurrency, and with 10 jobs over a
    // limit of 2 it must actually reach it at some point.
    const maxS3InFlight = Math.max(...s3Dispatches.map((l) => l.inFlight));
    expect(maxS3InFlight).toBeLessThanOrEqual(s3Parallelism);
    expect(maxS3InFlight).toBe(s3Parallelism);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
