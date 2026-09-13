import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { openStateDb } from "../../src/db/connection.js";
import { VersionsRepository } from "../../src/db/repositories/versions-repository.js";

function mkTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-uc-concurrency-"));
  fs.mkdirSync(path.join(root, ".sync1"));
  fs.writeFileSync(path.join(root, ".sync1", "last_synced_version"), "v0", "utf8");
  const stateDb = openStateDb(path.join(root, ".sync1", "state.db"));
  new VersionsRepository(stateDb).insert("v0", new Date().toISOString());
  stateDb.close();
  return root;
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

describe("update_cache: hash concurrency", () => {
  it("hashes multiple new files concurrently, never exceeding --hash-parallelism, and actually reaching it", async () => {
    const root = mkTempRoot();
    const fileCount = 10;
    const hashParallelism = 3;
    for (let i = 0; i < fileCount; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), `content of file ${i}`.repeat(1000));
    }

    // Not a TTY under execFile, so no progress bars -- --verbose logs land
    // directly on stderr (see src/cli/progress.ts's fd-3 diversion, which
    // only kicks in when bars are actually rendering).
    const result = await runCli([
      "update_cache",
      "--root",
      root,
      "--json",
      "--verbose",
      "--hash-parallelism",
      String(hashParallelism),
    ]);
    expect(result.exitCode).toBe(0);
    const stats = JSON.parse(result.stdout) as { created: number };
    expect(stats.created).toBe(fileCount);

    const dispatchLogs = parseDispatchLogs(result.stderr).filter(
      (l) => l.pool === "hash" && l.msg === "dispatched",
    );
    expect(dispatchLogs.length).toBe(fileCount);
    const maxInFlight = Math.max(...dispatchLogs.map((l) => l.inFlight));
    // Never exceeded the configured limit...
    expect(maxInFlight).toBeLessThanOrEqual(hashParallelism);
    // ...and actually reached it -- ruling out an accidentally-sequential
    // implementation that would also (trivially) never exceed the limit.
    expect(maxInFlight).toBe(hashParallelism);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
