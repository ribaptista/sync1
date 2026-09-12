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
import { createLogger } from "../../src/logger.js";
import { createS3Client } from "../../src/s3/client.js";
import { parseManifest, unlockVault } from "../../src/vault/manifest.js";
import { parseRemoteConfig } from "../../src/vault/remote-config.js";
import { localVaultJsonPath, localRemoteConfigPath } from "../../src/vault/local-dir.js";
import { normalizePrefix, type RemoteLocation } from "../../src/vault/paths.js";
import { mutateStateDb } from "../../src/sync/mutate-state-db.js";
import { StoragePoliciesRepository } from "../../src/db/repositories/storage-policies-repository.js";

const PASSWORD = "correct horse battery staple";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-storage-policy-retry-"));
}

function readStoragePolicies(
  root: string,
): Array<{ id: number; glob: string | null; target_class: string; priority: number | null }> {
  const db = new Database(path.join(root, ".sync1", "state.db"), { readonly: true });
  const rows = db
    .prepare(
      "SELECT id, glob, target_class, priority FROM storage_policies WHERE is_default = 0 ORDER BY id",
    )
    .all() as Array<{
    id: number;
    glob: string | null;
    target_class: string;
    priority: number | null;
  }>;
  db.close();
  return rows;
}

/**
 * Mirrors mutate_state_db_retry.test.ts's approach (mutateStateDb called
 * directly, not via a spawned CLI, since racing two real CLI processes
 * against LocalStack has no reliable window to land a competing commit
 * inside) -- this exercises the same generic CAS-retry helper against
 * storage_policies specifically, confirming its schema (CHECK constraints,
 * the seeded default row) doesn't trip up a mutation that has to retry.
 */
describe("mutateStateDb: CAS-conflict retry against storage_policies", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("refetches and recomputes when another commit lands between its read and its CAS attempt", async () => {
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

    const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(rootA)));
    const manifest = parseManifest(fs.readFileSync(localVaultJsonPath(rootA)));
    const masterKey = unlockVault(manifest, PASSWORD);
    const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
    const location: RemoteLocation = {
      bucket: remoteConfig.bucket,
      prefix: normalizePrefix(remoteConfig.prefix),
    };
    const logger = createLogger(false);

    let competingCommitDone = false;
    const { result: id } = await mutateStateDb(
      rootA,
      masterKey,
      { client, bucket: remoteConfig.bucket, location },
      logger,
      (db) => new StoragePoliciesRepository(db).create("archive/*", "DEEP_ARCHIVE", 1),
      async () => {
        if (competingCommitDone) return;
        competingCommitDone = true;
        // An unrelated commit from a second machine, landing exactly
        // between this attempt's read of /current and its own CAS attempt
        // -- forces the first CAS to fail against a stale etag.
        fs.writeFileSync(path.join(rootB, "unrelated.txt"), "from B, mid-mutation");
        const syncResult = await runCli(["sync", "--root", rootB, "--json"], {
          env: { SYNC1_PASSWORD: PASSWORD },
        });
        expect(syncResult.exitCode).toBe(0);
      },
    );

    expect(competingCommitDone).toBe(true);
    // Success (a real id assigned) is itself the proof the retry path ran:
    // without it, the CAS attempt against the now-stale etag would have
    // thrown instead of succeeding.
    expect(typeof id).toBe("number");

    expect(readStoragePolicies(rootA)).toEqual([
      { id, glob: "archive/*", target_class: "DEEP_ARCHIVE", priority: 1 },
    ]);

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });
});
