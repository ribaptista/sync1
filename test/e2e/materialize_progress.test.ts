import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import PQueue from "p-queue";
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
import {
  localVaultJsonPath,
  localRemoteConfigPath,
  localCacheDbPath,
  localStateDbPath,
} from "../../src/vault/local-dir.js";
import { normalizePrefix, type RemoteLocation } from "../../src/vault/paths.js";
import { openCacheDb } from "../../src/db/connection.js";
import { CacheEntriesRepository } from "../../src/db/repositories/cache-entries-repository.js";
import { ObjectsRepository } from "../../src/db/repositories/objects-repository.js";
import { materializeGlob } from "../../src/fs/materialize.js";
import type { ProgressUpdate } from "../../src/progress-types.js";

const PASSWORD = "correct horse battery staple";
const CONTENT = "x".repeat(4096);

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-materialize-progress-"));
}

/**
 * materializeGlob is called directly rather than through a spawned CLI
 * because progress updates are exactly what a subprocess can't hand back:
 * under `--json` the session is a no-op by design, and a real bar writes
 * ANSI to a TTY that isn't there. The same seam `gc_retry` uses for the
 * same reason.
 */
describe("materialize: progress totals", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  async function setUpVault(): Promise<{ root: string; bucket: string }> {
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
    return { root, bucket };
  }

  /** The same S3/master-key context materialize's own command wrapper builds. */
  function s3ContextFor(root: string) {
    const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
    const manifest = parseManifest(fs.readFileSync(localVaultJsonPath(root)));
    return {
      masterKey: unlockVault(manifest, PASSWORD),
      s3: {
        client: createS3Client({
          endpoint: remoteConfig.endpoint,
          region: remoteConfig.region,
        }),
        bucket: remoteConfig.bucket,
        location: {
          bucket: remoteConfig.bucket,
          prefix: normalizePrefix(remoteConfig.prefix),
        } satisfies RemoteLocation,
      },
    };
  }

  async function runMaterialize(
    root: string,
    glob: string,
    requestRetrieval = false,
  ): Promise<{ updates: ProgressUpdate[] }> {
    const { masterKey, s3 } = s3ContextFor(root);
    const logger = createLogger(false);
    const cacheDb = openCacheDb(localCacheDbPath(root), logger);
    const stateDb = new Database(localStateDbPath(root), { readonly: true, fileMustExist: true });
    const updates: ProgressUpdate[] = [];
    try {
      await materializeGlob(
        root,
        glob,
        new CacheEntriesRepository(cacheDb),
        new ObjectsRepository(stateDb),
        masterKey,
        requestRetrieval,
        s3,
        logger,
        new PQueue({ concurrency: 4 }),
        8,
        new PQueue({ concurrency: 4 }),
        8,
        (u) => updates.push({ ...u }),
      );
    } finally {
      cacheDb.close();
      stateDb.close();
    }
    return { updates };
  }

  it("knows the full byte total before a single byte has been downloaded", async () => {
    const { root } = await setUpVault();
    for (const name of ["a.bin", "b.bin", "c.bin"]) {
      fs.writeFileSync(path.join(root, name), CONTENT);
    }
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });
    await runCli(["stubify", "*.bin", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });

    const { updates } = await runMaterialize(root, "*.bin");

    const finalUpdate = updates.at(-1)!;
    expect(finalUpdate.bytesTotal).toBeGreaterThan(0);

    // The point of the whole change: the very first update already carries
    // the run's full byte total, rather than the total climbing toward it
    // as each HEAD comes back.
    expect(updates[0]?.bytesTotal).toBe(finalUpdate.bytesTotal);
    expect(updates[0]?.bytesDone).toBe(0);

    // ...and it never moves after that, in either direction.
    const distinctTotals = new Set(updates.map((u) => u.bytesTotal));
    expect([...distinctTotals]).toEqual([finalUpdate.bytesTotal]);

    // The run still lands exactly on its own denominator.
    expect(finalUpdate.bytesDone).toBe(finalUpdate.bytesTotal);
    expect(finalUpdate.filesDone).toBe(finalUpdate.filesTotal);
    expect(finalUpdate.totalsFinal).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("an archived object resolves its bytes without transferring them, still finishing at 100%", async () => {
    const { root } = await setUpVault();
    fs.writeFileSync(path.join(root, "cold.bin"), CONTENT);
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    // Actually move the object to GLACIER in S3, so materialize's HEAD
    // genuinely classifies it as needing a restore request rather than us
    // simulating that classification.
    await runCli(["storage_policy", "create", "cold.bin", "GLACIER", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    const converged = await runCli(["converge", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(converged.exitCode).toBe(0);

    await runCli(["stubify", "cold.bin", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });

    const { updates } = await runMaterialize(root, "cold.bin");
    const finalUpdate = updates.at(-1)!;

    // Nothing was downloaded -- the stub is still a stub -- yet the bytes
    // it was counted for are resolved, because the run *did* discharge its
    // responsibility for that object (by classifying it as needing a
    // retrieval request). A denominator that stayed outstanding here would
    // leave the bar permanently short.
    expect(fs.existsSync(path.join(root, "cold.bin.stub"))).toBe(true);
    expect(fs.existsSync(path.join(root, "cold.bin"))).toBe(false);
    expect(finalUpdate.bytesTotal).toBeGreaterThan(0);
    expect(finalUpdate.bytesDone).toBe(finalUpdate.bytesTotal);
    expect(finalUpdate.filesDone).toBe(finalUpdate.filesTotal);

    // No "downloading"/"downloaded" label was ever emitted for it: nothing
    // was read or written, and claiming otherwise would be a lie.
    expect(updates.some((u) => u.activity !== undefined)).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
