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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-ignore-drops-"));
}

/**
 * `update_cache`'s merge-join only ever ignore-checked a brand-new path,
 * never a path already sitting in cache.db as an uncommitted 'created' row
 * -- so a file discovered *before* a matching ignore policy existed stayed
 * dirty forever and would have been uploaded to the shared vault on the
 * next sync. This drives the fix through both the standalone command and
 * `sync`'s own internal scan (which runs the exact same merge-join), since
 * that second path is the one that actually matters for a real user.
 */
describe("update_cache/sync drop an uncommitted row a since-added ignore policy now matches", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("sync's own internal scan drops it too, reports it, and never uploads it", async () => {
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

    // Discovered and staged as an uncommitted 'created' row *before* any
    // ignore policy exists -- the realistic order of events this fix is
    // for (a scratch/log file dropped into a watched tree, noticed later).
    fs.writeFileSync(path.join(root, "scratch.tmp"), "not meant to be backed up");
    fs.writeFileSync(path.join(root, "keep.txt"), "genuinely wanted");
    const firstScan = await runCli(["update_cache", "--root", root, "--json"]);
    expect(firstScan.exitCode).toBe(0);
    const firstParsed = JSON.parse(firstScan.stdout) as { created: number };
    expect(firstParsed.created).toBe(2);

    const policy = await runCli(["ignore", "create", "*.tmp", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(policy.exitCode).toBe(0);

    const sync1 = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(sync1.exitCode).toBe(0);
    const parsed = JSON.parse(sync1.stdout) as {
      ok: boolean;
      uploaded_objects: number;
      local_entries_changed: number;
      dropped_ignored: string[];
    };
    expect(parsed.ok).toBe(true);
    // The whole point: dropped, not uploaded.
    expect(parsed.dropped_ignored).toEqual(["scratch.tmp"]);
    expect(parsed.uploaded_objects).toBe(1); // keep.txt only
    expect(parsed.local_entries_changed).toBe(1); // keep.txt only

    // A follow-up sanity_check confirms scratch.tmp is genuinely gone from
    // cache.db, not merely omitted from the summary -- and correctly
    // counted as ignored (untracked, matching a policy), not flagged as a
    // problem.
    const sanity = await runCli(["sanity_check", "--root", root, "--json"]);
    expect(sanity.exitCode).toBe(0);
    const sanityParsed = JSON.parse(sanity.stdout) as {
      ok: boolean;
      untracked: string[];
      ignored_count: number;
    };
    expect(sanityParsed.ok).toBe(true);
    expect(sanityParsed.untracked).not.toContain("scratch.tmp");
    expect(sanityParsed.ignored_count).toBe(1);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
