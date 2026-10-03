import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runCli } from "./helpers/cli.js";
import { openStateDb } from "../../src/db/connection.js";
import { VersionsRepository } from "../../src/db/repositories/versions-repository.js";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";

function readCachedPaths(root: string): string[] {
  const db = new Database(path.join(root, ".sync1", "cache.db"), { readonly: true });
  const rows = db.prepare<[], { path: string }>("SELECT path FROM entries ORDER BY path").all();
  db.close();
  return rows.map((r) => r.path);
}

// 251 bytes -- one over the 250-byte limit a real file's name has to stay
// under so that *some* future client (this machine via `stubify`, or
// another one via `sync`) can always write a ".stub" placeholder for it.
const TOO_LONG_NAME = `${"a".repeat(247)}.txt`;

function mkLocalRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-uc-namelimit-"));
  fs.mkdirSync(path.join(root, ".sync1"));
  fs.writeFileSync(path.join(root, ".sync1", "last_synced_version"), "v0", "utf8");
  const stateDb = openStateDb(path.join(root, ".sync1", "state.db"));
  new VersionsRepository(stateDb).insert("v0", new Date().toISOString());
  stateDb.close();
  return root;
}

const PASSWORD = "correct horse battery staple";

describe("update_cache / sync: refuse a name too long to ever take a .stub suffix", () => {
  it("update_cache fails with the offending path, and succeeds once it's renamed", async () => {
    const root = mkLocalRoot();
    fs.writeFileSync(path.join(root, TOO_LONG_NAME), "hello");

    const failed = await runCli(["update_cache", "--root", root, "--json"]);
    expect(failed.exitCode).not.toBe(0);
    const failedBody = JSON.parse(failed.stdout) as { ok: boolean; error: string };
    expect(failedBody.ok).toBe(false);
    expect(failedBody.error).toContain(TOO_LONG_NAME);

    fs.renameSync(path.join(root, TOO_LONG_NAME), path.join(root, "short.txt"));
    const fixed = await runCli(["update_cache", "--root", root, "--json"]);
    expect(fixed.exitCode).toBe(0);
    const fixedBody = JSON.parse(fixed.stdout) as { ok: boolean; created: number };
    expect(fixedBody).toMatchObject({ ok: true, created: 1 });

    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("sync", () => {
    let localstack: LocalStackHandle;

    beforeAll(async () => {
      localstack = await startLocalStack();
    });

    afterAll(async () => {
      await localstack.stop();
    });

    it("fails before uploading anything, and succeeds once the file is renamed", async () => {
      const s3 = createTestS3Client(localstack.endpoint);
      const bucket = await createFreshBucket(s3);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-sync-namelimit-"));

      const init = await runCli(
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
      expect(init.exitCode).toBe(0);

      fs.writeFileSync(path.join(root, TOO_LONG_NAME), "hello");
      fs.writeFileSync(path.join(root, "fine.txt"), "world");

      const failed = await runCli(["sync", "--root", root, "--json"], {
        env: { SYNC1_PASSWORD: PASSWORD },
      });
      expect(failed.exitCode).not.toBe(0);
      const failedBody = JSON.parse(failed.stdout) as { ok: boolean; error: string };
      expect(failedBody.ok).toBe(false);
      expect(failedBody.error).toContain(TOO_LONG_NAME);
      // Nothing from this run was staged -- not even the unrelated healthy
      // file discovered in the same local scan.
      expect(readCachedPaths(root)).toEqual([]);

      fs.renameSync(path.join(root, TOO_LONG_NAME), path.join(root, "short.txt"));
      const fixed = await runCli(["sync", "--root", root, "--json"], {
        env: { SYNC1_PASSWORD: PASSWORD },
      });
      expect(fixed.exitCode).toBe(0);
      const fixedBody = JSON.parse(fixed.stdout) as { ok: boolean };
      expect(fixedBody.ok).toBe(true);

      fs.rmSync(root, { recursive: true, force: true });
    });
  });
});
