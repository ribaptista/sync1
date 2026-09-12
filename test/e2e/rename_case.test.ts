import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";

const PASSWORD = "correct horse battery staple";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-rename-case-"));
}

function readStateDb(root: string): Database.Database {
  return new Database(path.join(root, ".sync1", "state.db"), { readonly: true });
}

describe("same-machine rename resolved as delete+create", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  /**
   * update_cache always resolves a rename as an independent delete+create
   * (there's no rename primitive anywhere in this system), which exposed an
   * ordering bug: iterateDirty()'s rows must be processed deletes-first, or
   * a same-machine rename can spuriously look like a case collision to
   * itself depending on which way the casing sorts alphabetically (see
   * docs/architecture/cross-platform-filesystem.md and
   * CacheEntriesRepository.iterateDirty()'s doc comment). These two tests
   * cover both directions, since the bug this guards against is
   * direction-dependent.
   */
  async function testRename(fromName: string, toName: string): Promise<void> {
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

    fs.writeFileSync(path.join(root, fromName), "renamed content");
    const firstSync = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(firstSync.exitCode).toBe(0);

    fs.renameSync(path.join(root, fromName), path.join(root, toName));
    const secondSync = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(secondSync.exitCode).toBe(0);
    const parsed = JSON.parse(secondSync.stdout) as {
      ok: boolean;
      uploaded_objects: number;
      deduped_objects: number;
      conflicts: unknown[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.conflicts).toEqual([]);
    // content already known from the first sync -- no re-upload
    expect(parsed.uploaded_objects).toBe(0);
    expect(parsed.deduped_objects).toBe(1);

    const stateDb = readStateDb(root);
    const paths = stateDb.prepare("SELECT path FROM entries").all() as Array<{ path: string }>;
    expect(paths.map((r) => r.path)).toEqual([toName]);
    stateDb.close();

    fs.rmSync(root, { recursive: true, force: true });
  }

  it("renames file.txt to FILE.txt (new name sorts alphabetically earlier)", async () => {
    await testRename("file.txt", "FILE.txt");
  });

  it("renames FILE.txt to file.txt (the reverse direction)", async () => {
    await testRename("FILE.txt", "file.txt");
  });
});
