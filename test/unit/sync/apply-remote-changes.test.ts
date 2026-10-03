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
    new ObjectsRepository(candidateDb).upsert({
      hash: HASH,
      s3_key: `objects/${HASH}`,
      size: 7,
      ciphertext_checksum: "crc-test",
    });
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

describe("applyRemoteChangesToLocal: download failure", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-apply-remote-changes-failure-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("propagates a download failure cleanly instead of an unhandled rejection, and never marks the row materialized", async () => {
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v1", new Date().toISOString());
    new ObjectsRepository(candidateDb).upsert({
      hash: HASH,
      s3_key: `objects/${HASH}`,
      size: 100,
      ciphertext_checksum: "crc-test",
    });
    new EntriesRepository(candidateDb).upsert({
      path: "photo.jpg",
      type: "file",
      hash: HASH,
      state_version: "v1",
    });

    const cacheDb = openCacheDb(":memory:");
    const cacheRepo = new CacheEntriesRepository(cacheDb);
    // A cache row already exists, with a DIFFERENT hash -- this is what
    // makes the merge-join see "modified" (both sides present, hashes
    // differ) rather than brand-new. A brand-new path always defaults to
    // a stub and never reaches the download branch at all, so it isn't a
    // usable shape for this test.
    const staleHash = "b".repeat(64);
    cacheRepo.upsert({
      path: "photo.jpg",
      type: "file",
      mtime: 1,
      hash: staleHash,
      size: 5,
      state: "unchanged",
      parent_state_version: "v0",
    });

    const streamPool = new PQueue({ concurrency: 4 });
    // unusedS3.client has no real send() method -- calling it throws
    // immediately (a plain TypeError, unclassified, so withS3Retry treats
    // it as non-transient rather than retrying it away), which is all
    // this test needs: any failure propagating cleanly out of
    // applyRemoteChangesToLocal, rather than becoming an unhandled
    // rejection or being silently swallowed the way a failed *upload* now
    // deliberately is (see apply-local-changes.ts) -- downloads keep
    // today's stricter behavior of ending the whole run.
    await expect(
      applyRemoteChangesToLocal(
        candidateDb,
        root,
        Buffer.alloc(32),
        cacheRepo,
        new Set<string>(),
        unusedS3,
        silentLogger,
        streamPool,
        8,
      ),
    ).rejects.toThrow();

    // The row was never touched: still whatever cache.db already had
    // before this run, not overwritten with content that never actually
    // arrived.
    expect(cacheRepo.get("photo.jpg")?.hash).toBe(staleHash);

    candidateDb.close();
    cacheDb.close();
  });
});

describe("applyRemoteChangesToLocal: periodic event-loop yield", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-apply-remote-changes-yield-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("yields to the event loop periodically, instead of running a stub-only pass as one synchronous block", async () => {
    // Regression test for a frozen progress bar: cli-progress's MultiBar
    // repaints off its own `setTimeout`, and every branch exercised here --
    // a brand-new path defaulting to a stub -- resolves synchronously
    // within applyRemoteContentChange. Without a periodic
    // `await setImmediate()` in the merge-join loop (see YIELD_EVERY_ROWS in
    // apply-remote-changes.ts), a run with no real downloads never yields
    // at all, so nothing else queued on the event loop gets a turn until
    // the whole pass finishes.
    //
    // Asserted with a `setImmediate` of our own, scheduled before the call,
    // rather than a `setTimeout` -- `setTimeout`/`setImmediate` ordering
    // isn't guaranteed across event-loop phases in general, but two
    // `setImmediate` callbacks are always run in scheduling order within
    // the same "check" phase. Since the production code's own yield also
    // goes through `setImmediate` (node:timers/promises), this one -- being
    // scheduled first -- is guaranteed to run before the production code's
    // *first* yield fires, which can only happen if that first yield was
    // actually reached (i.e. the loop didn't run start-to-finish first).
    const candidateDb = openStateDb(":memory:");
    new VersionsRepository(candidateDb).insert("v1", new Date().toISOString());
    const objects = new ObjectsRepository(candidateDb);
    const entries = new EntriesRepository(candidateDb);

    // One more row than the yield interval, so the loop crosses the
    // threshold at least once.
    const ROW_COUNT = 33;
    for (let i = 0; i < ROW_COUNT; i++) {
      const hash = i.toString().padStart(64, "0");
      objects.upsert({ hash, s3_key: `objects/${hash}`, size: 1, ciphertext_checksum: "crc-test" });
      entries.upsert({ path: `file-${i}.bin`, type: "file", hash, state_version: "v1" });
    }

    const cacheDb = openCacheDb(":memory:");
    const cacheRepo = new CacheEntriesRepository(cacheDb);

    let timerFired = false;
    setImmediate(() => {
      timerFired = true;
    });

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

    expect(timerFired).toBe(true);
    expect(cacheRepo.get("file-0.bin")?.hash).toBe("0".repeat(64));
    expect(cacheRepo.get(`file-${ROW_COUNT - 1}.bin`)?.hash).toBe(
      (ROW_COUNT - 1).toString().padStart(64, "0"),
    );

    candidateDb.close();
    cacheDb.close();
  });
});
