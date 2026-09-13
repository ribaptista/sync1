import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStateDb } from "../../../src/db/connection.js";
import { EntriesRepository } from "../../../src/db/repositories/entries-repository.js";
import { ObjectsRepository } from "../../../src/db/repositories/objects-repository.js";
import { IgnorePoliciesRepository } from "../../../src/db/repositories/ignore-policies-repository.js";
import { VersionsRepository } from "../../../src/db/repositories/versions-repository.js";
import { hashBufferHex, formatTaggedHash } from "../../../src/crypto/hash.js";
import { writeStubAtomic } from "../../../src/fs/stub.js";
import { performSanityCheck, type ObjectExistsChecker } from "../../../src/fs/sanity-check.js";

const silentLogger = {
  debug: () => {},
  warn: () => {},
} as unknown as import("../../../src/logger.js").Logger;

let root: string;
let dbDir: string;
let dbPath: string;
let entriesRepo: EntriesRepository;
let objectsRepo: ObjectsRepository;
let ignorePoliciesRepo: IgnorePoliciesRepository;
let existingS3Keys: Set<string>;

const alwaysExists: ObjectExistsChecker = (s3Key) => Promise.resolve(existingS3Keys.has(s3Key));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-sanity-check-test-"));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-sanity-check-db-"));
  dbPath = path.join(dbDir, "state.db");
  existingS3Keys = new Set();

  // One connection, exactly like the CLI command does -- entriesRepo's
  // iterateAllSortedByPath() is keyset-paginated, not a live `.iterate()`
  // cursor, so objectsRepo/ignorePoliciesRepo can safely share it.
  const db = openStateDb(dbPath);
  new VersionsRepository(db).insert("v0", new Date().toISOString());
  entriesRepo = new EntriesRepository(db);
  objectsRepo = new ObjectsRepository(db);
  ignorePoliciesRepo = new IgnorePoliciesRepository(db);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

function touch(relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function seedObject(hash: string, s3Key: string, size: number, present = true): void {
  objectsRepo.upsert({ hash, s3_key: s3Key, size });
  if (present) existingS3Keys.add(s3Key);
}

function seedEntry(filePath: string, hash: string | null, type: "file" | "dir" = "file"): void {
  entriesRepo.upsert({ path: filePath, type, hash, state_version: "v0" });
}

describe("performSanityCheck", () => {
  it("reports no problems for a fully clean, in-sync file", async () => {
    const hash = hashBufferHex(Buffer.from("hello"));
    touch("a.txt", "hello");
    seedObject(hash, "objects/a", 5);
    seedEntry("a.txt", hash);

    const result = await performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      alwaysExists,
      silentLogger,
    );
    expect(result).toEqual({
      bothStubAndReal: [],
      hashMismatch: [],
      stubMismatch: [],
      missingInS3: [],
      missingLocally: [],
      untracked: [],
      ignoredCount: 0,
    });
  });

  it("does not check directories any further once both sides agree they exist", async () => {
    fs.mkdirSync(path.join(root, "photos"));
    seedEntry("photos", null, "dir");

    const result = await performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      alwaysExists,
      silentLogger,
    );
    expect(result.missingLocally).toEqual([]);
    expect(result.untracked).toEqual([]);
  });

  it("reports bothStubAndReal when a stub and the real file coexist, without further checks", async () => {
    const hash = hashBufferHex(Buffer.from("real content"));
    touch("img.jpg", "real content");
    writeStubAtomic(path.join(root, "img.jpg.stub"), "c".repeat(64)); // bogus hash, deliberately
    seedObject(hash, "objects/img", 12, false); // present=false -- if this were checked
    // further it would also show up as missingInS3; it must not be, since
    // "both" short-circuits before the S3 check.
    seedEntry("img.jpg", hash);

    const result = await performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      alwaysExists,
      silentLogger,
    );
    expect(result.bothStubAndReal).toEqual(["img.jpg"]);
    expect(result.missingInS3).toEqual([]);
    expect(result.hashMismatch).toEqual([]);
  });

  it("reports hashMismatch when a real file's content no longer matches state.db", async () => {
    const originalHash = hashBufferHex(Buffer.from("original"));
    touch("a.txt", "tampered");
    seedObject(originalHash, "objects/a", 8);
    seedEntry("a.txt", originalHash);

    const result = await performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      alwaysExists,
      silentLogger,
    );
    expect(result.hashMismatch).toEqual([
      {
        path: "a.txt",
        expectedHash: originalHash,
        actualHash: hashBufferHex(Buffer.from("tampered")),
      },
    ]);
  });

  it("reports stubMismatch for a malformed stub", async () => {
    const hash = "d".repeat(64);
    fs.writeFileSync(path.join(root, "bad.jpg.stub"), "not-a-valid-tagged-hash");
    seedObject(hash, "objects/bad", 1);
    seedEntry("bad.jpg", hash);

    const result = await performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      alwaysExists,
      silentLogger,
    );
    expect(result.stubMismatch).toHaveLength(1);
    expect(result.stubMismatch[0]!.path).toBe("bad.jpg");
    expect(result.stubMismatch[0]!.reason).toMatch(/malformed stub content/);
  });

  it("reports stubMismatch when a valid stub declares a hash different from state.db's", async () => {
    const declaredHash = "a".repeat(64);
    const expectedHash = "b".repeat(64);
    writeStubAtomic(path.join(root, "img.jpg.stub"), declaredHash);
    seedObject(expectedHash, "objects/img", 1);
    seedEntry("img.jpg", expectedHash);

    const result = await performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      alwaysExists,
      silentLogger,
    );
    expect(result.stubMismatch).toEqual([
      {
        path: "img.jpg",
        reason: `stub declares hash ${declaredHash}, state.db expects ${expectedHash}`,
      },
    ]);
  });

  it("reports missingInS3 when the object row exists but the S3 object itself doesn't", async () => {
    const hash = hashBufferHex(Buffer.from("hello"));
    touch("a.txt", "hello");
    seedObject(hash, "objects/a", 5, false); // present=false: row exists, S3 object doesn't
    seedEntry("a.txt", hash);

    const result = await performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      alwaysExists,
      silentLogger,
    );
    expect(result.missingInS3).toEqual([{ path: "a.txt", hash }]);
  });

  it("reports missingLocally for a tracked entry with no local presence at all", async () => {
    const hash = hashBufferHex(Buffer.from("gone"));
    seedObject(hash, "objects/gone", 4);
    seedEntry("gone.txt", hash);

    const result = await performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      alwaysExists,
      silentLogger,
    );
    expect(result.missingLocally).toEqual(["gone.txt"]);
  });

  it("reports untracked for a local file with no state.db entry and no ignore match", async () => {
    touch("stray.txt", "surprise");

    const result = await performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      alwaysExists,
      silentLogger,
    );
    expect(result.untracked).toEqual(["stray.txt"]);
    expect(result.ignoredCount).toBe(0);
  });

  it("counts, but does not report as untracked, a local file matching an ignore policy", async () => {
    ignorePoliciesRepo.create("*.tmp");
    touch("scratch.tmp", "throwaway");
    touch("stray.txt", "surprise");

    const result = await performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      alwaysExists,
      silentLogger,
    );
    expect(result.untracked).toEqual(["stray.txt"]);
    expect(result.ignoredCount).toBe(1);
  });

  it("scopes reporting to --filter, without misclassifying out-of-scope paths", async () => {
    const hash = hashBufferHex(Buffer.from("hello"));
    touch("keep/a.txt", "hello");
    seedObject(hash, "objects/a", 5);
    seedEntry("keep/a.txt", hash);
    const goneHash = hashBufferHex(Buffer.from("gone"));
    seedObject(goneHash, "objects/gone", 4);
    seedEntry("elsewhere/gone.txt", goneHash); // out of scope
    touch("elsewhere/stray.txt", "surprise"); // out of scope

    const result = await performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      alwaysExists,
      silentLogger,
      "keep/*",
    );
    expect(result.missingLocally).toEqual([]);
    expect(result.untracked).toEqual([]);
    expect(result.hashMismatch).toEqual([]);
    expect(result.missingInS3).toEqual([]);
  });

  it("uses the tagged-hash format sanity check helper correctly for a happy-path stub", async () => {
    const hash = hashBufferHex(Buffer.from("steady content"));
    writeStubAtomic(path.join(root, "img.jpg.stub"), hash);
    seedObject(hash, "objects/img", 14);
    seedEntry("img.jpg", hash);

    const result = await performSanityCheck(
      root,
      entriesRepo,
      objectsRepo,
      ignorePoliciesRepo,
      alwaysExists,
      silentLogger,
    );
    expect(result.stubMismatch).toEqual([]);
    expect(result.missingInS3).toEqual([]);
    // sanity: formatTaggedHash round-trips through writeStubAtomic/readStubHash
    expect(formatTaggedHash(hash)).toMatch(/^blake2b:/);
  });
});
