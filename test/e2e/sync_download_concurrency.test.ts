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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-sync-download-concurrency-"));
}

async function sync(root: string, extraArgs: string[] = []) {
  const result = await runCli(["sync", "--root", root, "--json", ...extraArgs], {
    env: { SYNC1_PASSWORD: PASSWORD },
  });
  return { ...result, parsed: JSON.parse(result.stdout) as Record<string, unknown> };
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

describe("sync: remote-apply download concurrency", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("downloads multiple already-materialized modified paths concurrently, bounded by --file-stream-parallelism", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const rootA = mkTempRoot();
    const rootB = mkTempRoot();
    const fileCount = 8;

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
    for (let i = 0; i < fileCount; i++) {
      fs.writeFileSync(path.join(rootA, `f${i}.txt`), `version 1 of file ${i}`.repeat(2000));
    }
    expect((await sync(rootA)).exitCode).toBe(0);

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
    expect((await sync(rootB)).exitCode).toBe(0); // pulls down as stubs

    // Materialize every stub on B -- from here on, B's cache.db knows these
    // paths as real (non-stub) files, so a future remote change to them
    // must download, not just update a stub.
    const materializeResult = await runCli(["materialize", "*", "--root", rootB, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(materializeResult.exitCode).toBe(0);
    for (let i = 0; i < fileCount; i++) {
      expect(fs.existsSync(path.join(rootB, `f${i}.txt`))).toBe(true);
    }

    // Modify every file's content on A and sync -- B will see all of them
    // as "already materialized, remote content changed" on its own sync.
    for (let i = 0; i < fileCount; i++) {
      fs.writeFileSync(path.join(rootA, `f${i}.txt`), `version 2 of file ${i}`.repeat(2000));
    }
    expect((await sync(rootA)).exitCode).toBe(0);

    const fileStreamParallelism = 3;
    const syncB = await runCli(
      [
        "sync",
        "--root",
        rootB,
        "--json",
        "--verbose",
        "--file-stream-parallelism",
        String(fileStreamParallelism),
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(syncB.exitCode).toBe(0);
    const parsed = JSON.parse(syncB.stdout) as { remote_modified: number };
    expect(parsed.remote_modified).toBe(fileCount);

    for (let i = 0; i < fileCount; i++) {
      expect(fs.readFileSync(path.join(rootB, `f${i}.txt`), "utf8")).toBe(
        `version 2 of file ${i}`.repeat(2000),
      );
    }

    const dispatchLogs = parseDispatchLogs(syncB.stderr).filter(
      (l) => l.pool === "stream" && l.msg === "dispatched",
    );
    expect(dispatchLogs.length).toBe(fileCount);
    const maxInFlight = Math.max(...dispatchLogs.map((l) => l.inFlight));
    expect(maxInFlight).toBeLessThanOrEqual(fileStreamParallelism);
    expect(maxInFlight).toBe(fileStreamParallelism);

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });
});
