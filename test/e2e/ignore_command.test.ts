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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-ignore-"));
}

function readIgnorePolicies(root: string): Array<{ id: number; glob: string }> {
  const db = new Database(path.join(root, ".sync1", "state.db"), { readonly: true });
  const rows = db.prepare("SELECT id, glob FROM ignore_policies ORDER BY id").all() as Array<{
    id: number;
    glob: string;
  }>;
  db.close();
  return rows;
}

describe("ignore command", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("round-trips list/create/edit/delete through real commits", async () => {
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

    const emptyList = await runCli(["ignore", "list", "--root", root, "--json"]);
    expect(emptyList.exitCode).toBe(0);
    expect((JSON.parse(emptyList.stdout) as { policies: unknown[] }).policies).toEqual([]);

    const create = await runCli(["ignore", "create", "*.tmp", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(create.exitCode).toBe(0);
    const createParsed = JSON.parse(create.stdout) as { ok: boolean; id: number };
    expect(createParsed.ok).toBe(true);
    const id = createParsed.id;

    expect(readIgnorePolicies(root)).toEqual([{ id, glob: "*.tmp" }]);

    const edit = await runCli(["ignore", "edit", String(id), "*.bak", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(edit.exitCode).toBe(0);
    expect(readIgnorePolicies(root)).toEqual([{ id, glob: "*.bak" }]);

    const editMissing = await runCli(
      ["ignore", "edit", "9999", "*.nope", "--root", root, "--json"],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(editMissing.exitCode).not.toBe(0);

    const del = await runCli(["ignore", "delete", String(id), "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(del.exitCode).toBe(0);
    expect(readIgnorePolicies(root)).toEqual([]);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
