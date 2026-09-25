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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-temp-cleanup-"));
}

/**
 * Ctrl+C (`handleTerminationSignal`, src/cli.ts) calls `process.exit()`, so
 * no `finally` runs -- a `.sync1/state.db.candidate-*`/`*.remote-fresh-*`
 * left mid-commit, or an in-tree `<file>.sync1-tmp-*` left mid-download,
 * used to persist forever with nothing ever sweeping them, and the in-tree
 * ones weren't even excluded by the walker -- so the next `update_cache`
 * picked one up as a genuine new file and synced it. Reliably timing a real
 * SIGINT mid-transfer against LocalStack for this would be its own source
 * of flakiness, and test/e2e/lock.test.ts already proves the *lock itself*
 * is released on SIGINT -- so this seeds exactly what an interrupted run
 * would have left behind, directly, and drives the real CLI to prove both
 * halves of the fix through their actual wiring (cli.ts's preAction hook,
 * and the walker's own exclusion) rather than only the isolated units.
 */
describe("stale temp files from an interrupted run", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("sweeps .sync1/-internal leftovers on the next command, and never picks up an in-tree leftover as a new file", async () => {
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

    const sync1Dir = path.join(root, ".sync1");

    // Exactly what commit.ts's tempSiblingPath calls would have left behind
    // mid-commit -- including WAL sidecars, since these are real SQLite DBs
    // opened in WAL mode.
    const staleSync1Files = [
      "state.db.candidate-a1b2c3d4",
      "state.db.candidate-a1b2c3d4-wal",
      "state.db.candidate-a1b2c3d4-shm",
      "state.db.remote-fresh-deadbeef",
    ];
    for (const name of staleSync1Files) {
      fs.writeFileSync(path.join(sync1Dir, name), "leftover from an interrupted commit");
    }

    // Exactly what an interrupted download (apply-remote-changes.ts) or
    // stub write (stub.ts) would have left behind, right next to a real,
    // genuinely-tracked file in the working tree.
    const inTreeTempName = `.sync1-tmp-${"cafef00d".repeat(4)}`;
    fs.writeFileSync(path.join(root, "photo.jpg"), "real, tracked content");
    fs.writeFileSync(path.join(root, inTreeTempName), "half-downloaded, never renamed into place");

    const result = await runCli(["update_cache", "--root", root, "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; created: number };
    expect(parsed.ok).toBe(true);
    // Exactly one real path -- the in-tree temp file was never reported as
    // a second, genuine new file to track.
    expect(parsed.created).toBe(1);

    // The stale .sync1/-internal files are gone, swept by this same
    // command's preAction hook before its own action ever ran.
    for (const name of staleSync1Files) {
      expect(fs.existsSync(path.join(sync1Dir, name))).toBe(false);
    }
    // The in-tree temp file itself is untouched on disk (the walker just
    // never reports it as a tracked path -- sweeping it isn't this fix's
    // job, and it isn't in .sync1/ for the startup sweep to reach either).
    expect(fs.existsSync(path.join(root, inTreeTempName))).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
