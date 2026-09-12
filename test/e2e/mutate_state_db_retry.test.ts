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
import { createLogger } from "../../src/logger.js";
import { createS3Client } from "../../src/s3/client.js";
import { parseManifest, unlockVault } from "../../src/vault/manifest.js";
import { parseRemoteConfig } from "../../src/vault/remote-config.js";
import { localVaultJsonPath, localRemoteConfigPath } from "../../src/vault/local-dir.js";
import { normalizePrefix, type RemoteLocation } from "../../src/vault/paths.js";
import { mutateStateDb } from "../../src/sync/mutate-state-db.js";
import { IgnorePoliciesRepository } from "../../src/db/repositories/ignore-policies-repository.js";

const PASSWORD = "correct horse battery staple";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-mutate-retry-"));
}

/**
 * mutateStateDb is called directly here (not via a spawned CLI process),
 * for the same reason gc_retry.test.ts does: racing two independent
 * processes against a real (if fast) LocalStack backend has no reliable
 * window to land a competing commit inside. `onBeforeCas` is a test-only
 * seam, mirroring gc.ts's own, giving a fixed point to inject a real
 * competing commit and force an actual CAS retry.
 */
describe("mutateStateDb: CAS-conflict retry", () => {
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
      (db) => new IgnorePoliciesRepository(db).create("*.tmp"),
      async () => {
        if (competingCommitDone) return;
        competingCommitDone = true;
        // A completely unrelated commit from a second machine, landing
        // exactly between this attempt's read of /current and its own CAS
        // attempt -- forces the first CAS to fail against a stale etag.
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

    // The mutation actually landed in the final committed state, alongside
    // B's unrelated competing commit.
    const finalList = await runCli(["ignore", "list", "--root", rootA, "--json"]);
    const finalParsed = JSON.parse(finalList.stdout) as {
      policies: Array<{ id: number; glob: string }>;
    };
    expect(finalParsed.policies).toEqual([{ id, glob: "*.tmp", created_at: expect.any(String) }]);

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });
});
