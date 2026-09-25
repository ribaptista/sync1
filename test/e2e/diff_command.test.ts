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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-diff-"));
}

interface DiffSummary {
  ok: boolean;
  created: number;
  modified: number;
  deleted: number;
  total: number;
}

interface DiffRow {
  path: string;
  state: string;
  type: string;
}

/** JSONL: a row per change, then the summary last -- see `inspect`'s own precedent. */
function parseJsonl(stdout: string): { rows: DiffRow[]; summary: DiffSummary } {
  const lines = stdout.trim().split("\n").filter(Boolean);
  const summary = JSON.parse(lines[lines.length - 1] ?? "{}") as DiffSummary;
  const rows = lines.slice(0, -1).map((l) => JSON.parse(l) as DiffRow);
  return { rows, summary };
}

/**
 * `diff` reads cache.db and nothing else -- no state.db, no S3, no
 * password -- so the only reason this needs LocalStack at all is
 * `init_remote`, which is how a root gets a cache.db in the first place.
 */
describe("diff command", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("reports created, modified and deleted paths with a summary, and nothing for a clean tree", async () => {
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

    // Before any scan there is nothing to report *from*, and saying "0
    // changes" would read as "nothing changed" rather than "nothing was
    // looked at" -- so this is a clear error, not a misleading zero.
    const unscanned = await runCli(["diff", "--root", root, "--json"]);
    expect(unscanned.exitCode).toBe(1);
    expect(JSON.parse(unscanned.stdout) as { ok: boolean; error: string }).toMatchObject({
      ok: false,
      error: expect.stringContaining("update_cache") as string,
    });

    // An empty, scanned tree has no changes.
    await runCli(["update_cache", "--root", root, "--json"]);
    const empty = await runCli(["diff", "--root", root, "--json"]);
    expect(empty.exitCode).toBe(0);
    expect(parseJsonl(empty.stdout).summary).toMatchObject({ ok: true, total: 0 });

    // Commit a baseline so later edits can register as modified/deleted
    // rather than all looking newly created.
    fs.writeFileSync(path.join(root, "keep.txt"), "original");
    fs.writeFileSync(path.join(root, "goes-away.txt"), "doomed");
    await runCli(["update_cache", "--root", root, "--json"]);
    const synced = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(synced.exitCode).toBe(0);

    // A committed tree is clean again -- the states were reconciled.
    const afterSync = await runCli(["diff", "--root", root, "--json"]);
    expect(parseJsonl(afterSync.stdout).summary).toMatchObject({ total: 0 });

    // One of each kind.
    fs.writeFileSync(path.join(root, "brand-new.txt"), "new");
    fs.writeFileSync(path.join(root, "keep.txt"), "edited");
    fs.rmSync(path.join(root, "goes-away.txt"));
    await runCli(["update_cache", "--root", root, "--json"]);

    const result = await runCli(["diff", "--root", root, "--json"]);
    expect(result.exitCode).toBe(0); // a report, never a failure
    const { rows, summary } = parseJsonl(result.stdout);
    expect(summary).toMatchObject({ ok: true, created: 1, modified: 1, deleted: 1, total: 3 });

    const byPath = Object.fromEntries(rows.map((r) => [r.path, r.state]));
    expect(byPath).toMatchObject({
      "brand-new.txt": "created",
      "keep.txt": "modified",
      "goes-away.txt": "deleted",
    });
    // Deletions come first, from iterateDirty's own ordering -- the order
    // sync itself applies them in.
    expect(rows[0]?.state).toBe("deleted");

    // Plain-text mode: one line per change, then the summary.
    const plain = await runCli(["diff", "--root", root]);
    expect(plain.stdout).toContain("created   brand-new.txt");
    expect(plain.stdout).toContain("modified  keep.txt");
    expect(plain.stdout).toContain("deleted   goes-away.txt");
    expect(plain.stdout.trim().split("\n").at(-1)).toBe(
      "diff: 1 created, 1 modified, 1 deleted (3 pending)",
    );

    // --glob scopes the listing and the counts together.
    const scoped = await runCli(["diff", "--root", root, "--glob", "keep.*", "--json"]);
    const scopedParsed = parseJsonl(scoped.stdout);
    expect(scopedParsed.summary).toMatchObject({ created: 0, modified: 1, deleted: 0, total: 1 });
    expect(scopedParsed.rows.map((r) => r.path)).toEqual(["keep.txt"]);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
