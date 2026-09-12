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
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-storage-policy-"));
}

function readStoragePolicies(root: string): Array<{
  id: number;
  glob: string | null;
  target_class: string;
  priority: number | null;
  is_default: number;
}> {
  const db = new Database(path.join(root, ".sync1", "state.db"), { readonly: true });
  const rows = db
    .prepare(
      "SELECT id, glob, target_class, priority, is_default FROM storage_policies ORDER BY id",
    )
    .all() as Array<{
    id: number;
    glob: string | null;
    target_class: string;
    priority: number | null;
    is_default: number;
  }>;
  db.close();
  return rows;
}

describe("storage_policy command", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("round-trips list/create/edit/delete through real commits, seeded with a default row", async () => {
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

    const initialList = await runCli(["storage_policy", "list", "--root", root, "--json"]);
    expect(initialList.exitCode).toBe(0);
    const initialParsed = JSON.parse(initialList.stdout) as {
      policies: Array<{ id: number; is_default: number; target_class: string }>;
    };
    expect(initialParsed.policies).toEqual([
      {
        id: expect.any(Number),
        glob: null,
        target_class: "STANDARD",
        priority: null,
        is_default: 1,
      },
    ]);
    const defaultId = initialParsed.policies[0]!.id;

    const create = await runCli(
      ["storage_policy", "create", "archive/*", "DEEP_ARCHIVE", "--root", root, "--json"],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(create.exitCode).toBe(0);
    const createParsed = JSON.parse(create.stdout) as { ok: boolean; id: number };
    expect(createParsed.ok).toBe(true);
    const id = createParsed.id;

    expect(readStoragePolicies(root)).toEqual([
      { id: defaultId, glob: null, target_class: "STANDARD", priority: null, is_default: 1 },
      { id, glob: "archive/*", target_class: "DEEP_ARCHIVE", priority: 0, is_default: 0 },
    ]);

    const edit = await runCli(
      ["storage_policy", "edit", String(id), "--class", "GLACIER", "--root", root, "--json"],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(edit.exitCode).toBe(0);
    expect(readStoragePolicies(root)).toEqual([
      { id: defaultId, glob: null, target_class: "STANDARD", priority: null, is_default: 1 },
      { id, glob: "archive/*", target_class: "GLACIER", priority: 0, is_default: 0 },
    ]);

    const editMissing = await runCli(
      ["storage_policy", "edit", "9999", "--class", "STANDARD", "--root", root, "--json"],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(editMissing.exitCode).not.toBe(0);

    const del = await runCli(["storage_policy", "delete", String(id), "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(del.exitCode).toBe(0);
    expect(readStoragePolicies(root)).toEqual([
      { id: defaultId, glob: null, target_class: "STANDARD", priority: null, is_default: 1 },
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("auto-assigns an appended priority when --priority is omitted", async () => {
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

    await runCli(["storage_policy", "create", "a/*", "GLACIER", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    await runCli(["storage_policy", "create", "b/*", "DEEP_ARCHIVE", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    const third = await runCli(
      ["storage_policy", "create", "c/*", "GLACIER", "--priority", "5", "--root", root, "--json"],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(third.exitCode).toBe(0);
    await runCli(["storage_policy", "create", "d/*", "GLACIER", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });

    const nonDefault = readStoragePolicies(root).filter((r) => r.is_default === 0);
    expect(nonDefault.map((r) => r.priority)).toEqual([0, 1, 5, 6]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects deleting or changing the glob/priority of the default policy, but allows changing its class", async () => {
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
    const defaultId = readStoragePolicies(root)[0]!.id;

    const deleteDefault = await runCli(
      ["storage_policy", "delete", String(defaultId), "--root", root, "--json"],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(deleteDefault.exitCode).not.toBe(0);

    const editGlob = await runCli(
      ["storage_policy", "edit", String(defaultId), "--glob", "*", "--root", root, "--json"],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(editGlob.exitCode).not.toBe(0);

    const editClass = await runCli(
      ["storage_policy", "edit", String(defaultId), "--class", "GLACIER", "--root", root, "--json"],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    expect(editClass.exitCode).toBe(0);
    expect(readStoragePolicies(root)).toEqual([
      { id: defaultId, glob: null, target_class: "GLACIER", priority: null, is_default: 1 },
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
