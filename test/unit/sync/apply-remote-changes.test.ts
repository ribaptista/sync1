import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import PQueue from "p-queue";
import { openStateDb, openCacheDb } from "../../../src/db/connection.js";
import { EntriesRepository } from "../../../src/db/repositories/entries-repository.js";
import { ObjectsRepository } from "../../../src/db/repositories/objects-repository.js";
import { VersionsRepository } from "../../../src/db/repositories/versions-repository.js";
import { CacheEntriesRepository } from "../../../src/db/repositories/cache-entries-repository.js";
import { applyRemoteChangesToLocal } from "../../../src/sync/apply-remote-changes.js";

const silentLogger = {
  debug: () => {},
  warn: () => {},
} as unknown as import("../../../src/logger.js").Logger;

// Never actually called: a brand-new remote path defaults to a stub write,
// which needs no download at all.
const unusedS3 = {
  client: {} as S3Client,
  bucket: "unused",
  location: { bucket: "unused", prefix: "" },
};

const HASH = "a".repeat(64);

describe("applyRemoteChangesToLocal: parent_state_version bookkeeping", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-apply-remote-changes-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stamps a pulled-down row with that entry's own state_version, not the newest version in the vault", async () => {
    const candidateDb = openStateDb(":memory:");
    const versions = new VersionsRepository(candidateDb);
    // Two versions exist. "v2" is newer -- it stands in for any later commit
    // (e.g. a policy mutation, or this machine's own commit of some other
    // path) that never rewrote this entry's row.
    versions.insert("v1", new Date().toISOString());
    versions.insert("v2", new Date().toISOString());
    new ObjectsRepository(candidateDb).upsert({ hash: HASH, s3_key: `objects/${HASH}`, size: 7 });
    new EntriesRepository(candidateDb).upsert({
      path: "photo.jpg",
      type: "file",
      hash: HASH,
      state_version: "v1",
    });

    const cacheDb = openCacheDb(":memory:");
    const cacheRepo = new CacheEntriesRepository(cacheDb);

    await applyRemoteChangesToLocal(
      candidateDb,
      root,
      Buffer.alloc(32),
      cacheRepo,
      new Set<string>(),
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
    );

    // conflict-rules.ts compares a cache row's parent_state_version against
    // the candidate entry's own state_version -- so this must mirror "v1",
    // the version at which *this path* was last written. Stamping it with
    // the commit currently in flight ("v2" here) is what produced spurious
    // "modified remotely" conflicts on the next local edit/delete.
    expect(cacheRepo.get("photo.jpg")?.parent_state_version).toBe("v1");

    candidateDb.close();
    cacheDb.close();
  });

  it("stamps a pulled-down directory row the same way", async () => {
    const candidateDb = openStateDb(":memory:");
    const versions = new VersionsRepository(candidateDb);
    versions.insert("v1", new Date().toISOString());
    versions.insert("v2", new Date().toISOString());
    new EntriesRepository(candidateDb).upsert({
      path: "photos",
      type: "dir",
      hash: null,
      state_version: "v1",
    });

    const cacheDb = openCacheDb(":memory:");
    const cacheRepo = new CacheEntriesRepository(cacheDb);

    await applyRemoteChangesToLocal(
      candidateDb,
      root,
      Buffer.alloc(32),
      cacheRepo,
      new Set<string>(),
      unusedS3,
      silentLogger,
      new PQueue({ concurrency: 4 }),
      8,
    );

    expect(cacheRepo.get("photos")?.parent_state_version).toBe("v1");

    candidateDb.close();
    cacheDb.close();
  });
});
