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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-ignore-remote-"));
}

async function sync(root: string) {
  const result = await runCli(["sync", "--root", root, "--json"], {
    env: { SYNC1_PASSWORD: PASSWORD },
  });
  return { ...result, parsed: JSON.parse(result.stdout) as Record<string, unknown> };
}

describe("ignore policies vs. already-shared remote content", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("still materializes pre-existing shared content on another machine, with a warning, and no exit code change", async () => {
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

    // Committed *before* any ignore policy exists.
    fs.writeFileSync(path.join(rootA, "shared.txt"), "original content");
    const syncA = await sync(rootA);
    expect(syncA.exitCode).toBe(0);

    // Now a global ignore policy matching it is added -- a real commit.
    const create = await runCli(["ignore", "create", "shared.txt", "--root", rootA, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(create.exitCode).toBe(0);

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

    // B has never seen "shared.txt" before -- it's a new path to B's cache,
    // and the ignore policy now matches it. It must still be materialized
    // (as a stub, the usual default for a brand-new remote path), but
    // reported as a warning, with sync's exit code unaffected.
    const syncB = await sync(rootB);
    expect(syncB.exitCode).toBe(0);
    expect(syncB.parsed.ok).toBe(true);
    expect(syncB.parsed.remote_created).toBe(1);

    const ignoredButSynced = syncB.parsed.ignored_but_synced as Array<{
      path: string;
      matched_glob: string;
    }>;
    expect(ignoredButSynced).toEqual([{ path: "shared.txt", matched_glob: "shared.txt" }]);

    expect(fs.existsSync(path.join(rootB, "shared.txt"))).toBe(false);
    expect(fs.existsSync(path.join(rootB, "shared.txt.stub"))).toBe(true);

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });
});
