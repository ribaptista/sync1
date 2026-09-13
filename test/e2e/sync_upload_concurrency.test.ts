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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-sync-upload-concurrency-"));
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

describe("sync: upload concurrency", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("uploads multiple distinct new files concurrently, bounded by --file-stream-parallelism", async () => {
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

    const fileCount = 8;
    // Distinct content per file -- every one needs a genuine, separate
    // upload (no same-batch dedup), which is what this test needs to
    // observe real overlap between them.
    for (let i = 0; i < fileCount; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), `distinct content ${i}`.repeat(2000));
    }

    const fileStreamParallelism = 3;
    const result = await runCli(
      [
        "sync",
        "--root",
        root,
        "--json",
        "--verbose",
        "--file-stream-parallelism",
        String(fileStreamParallelism),
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { uploaded_objects: number };
    expect(parsed.uploaded_objects).toBe(fileCount);

    const dispatchLogs = parseDispatchLogs(result.stderr).filter(
      (l) => l.pool === "stream" && l.msg === "dispatched",
    );
    expect(dispatchLogs.length).toBe(fileCount);
    const maxInFlight = Math.max(...dispatchLogs.map((l) => l.inFlight));
    expect(maxInFlight).toBeLessThanOrEqual(fileStreamParallelism);
    expect(maxInFlight).toBe(fileStreamParallelism);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
