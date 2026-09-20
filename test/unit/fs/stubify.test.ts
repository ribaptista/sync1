import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCacheDb } from "../../../src/db/connection.js";
import { CacheEntriesRepository } from "../../../src/db/repositories/cache-entries-repository.js";
import { hashFile } from "../../../src/fs/hash-file.js";
import { hashBufferHex } from "../../../src/crypto/hash.js";
import { stubifyGlob } from "../../../src/fs/stubify.js";
import type { HashRunner } from "../../../src/concurrency/hash-runner.js";
import type { ProgressUpdate } from "../../../src/progress-types.js";

const silentLogger = {
  debug: () => {},
  warn: () => {},
} as unknown as import("../../../src/logger.js").Logger;

const defaultHashRunner: HashRunner = { run: (absolutePath) => hashFile(absolutePath) };

let root: string;
let repo: CacheEntriesRepository;
let cacheDb: ReturnType<typeof openCacheDb>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-stubify-test-"));
  cacheDb = openCacheDb(path.join(root, "cache.db"), silentLogger);
  repo = new CacheEntriesRepository(cacheDb);
});

afterEach(() => {
  cacheDb.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Writes a real file and the committed cache row that tracks it, with a
 * deliberately stale `mtime` so stubify has to rehash before it will
 * replace the file with a stub -- the only path that reads bytes, and
 * therefore the only one the byte total is about.
 */
function trackedFileNeedingRehash(relPath: string, content: string): void {
  fs.writeFileSync(path.join(root, relPath), content);
  repo.upsert({
    path: relPath,
    type: "file",
    mtime: 1, // never the real mtime
    hash: hashBufferHex(Buffer.from(content)),
    size: content.length,
    state: "unchanged",
    parent_state_version: "v1",
  });
}

describe("stubifyGlob: byte progress", () => {
  it("knows the whole byte total while the hash pool is still blocking the producer", async () => {
    // The regression this enumeration pass exists to prevent, in stubify's
    // own terms: three files, a hash pool of one, and a runner that never
    // resolves, so the producer loop dispatches the first row and then
    // blocks on the pool for the rest of the test. Discovery-driven totals
    // could only ever have seen ONE file's bytes by now.
    trackedFileNeedingRehash("a.txt", "a".repeat(100));
    trackedFileNeedingRehash("b.txt", "b".repeat(200));
    trackedFileNeedingRehash("c.txt", "c".repeat(400));

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    const hashRunner: HashRunner = {
      run: async (absolutePath) => {
        await gate;
        return hashFile(absolutePath);
      },
    };

    const updates: ProgressUpdate[] = [];
    const statsPromise = stubifyGlob(root, "**", repo, silentLogger, hashRunner, 1, (u) =>
      updates.push({ ...u }),
    );

    await vi.waitFor(() => {
      expect(updates.some((u) => u.bytesTotal === 700)).toBe(true);
    });
    // Nothing has finished hashing: the total came from the enumeration
    // pass running ahead of the blocked producer, not from dispatch, which
    // by now has only ever seen a.txt's 100 bytes.
    expect(updates.every((u) => u.bytesDone === 0)).toBe(true);
    expect(updates.some((u) => u.filesTotal === 3)).toBe(true);

    openGate();
    const stats = await statsPromise;
    expect(stats.stubified).toBe(3);

    const last = updates.at(-1)!;
    expect(last.bytesDone).toBe(700);
    expect(last.bytesTotal).toBe(700);
    expect(last.totalsFinal).toBe(true);
  });

  it("counts a row whose mtime still matches as a file worth zero bytes", async () => {
    // The fast path: stubify replaces this with a stub without reading a
    // single byte, so it belongs in filesTotal and nowhere near bytesTotal.
    const content = "unchanged content";
    fs.writeFileSync(path.join(root, "a.txt"), content);
    repo.upsert({
      path: "a.txt",
      type: "file",
      mtime: Math.round(fs.statSync(path.join(root, "a.txt")).mtimeMs),
      hash: hashBufferHex(Buffer.from(content)),
      size: content.length,
      state: "unchanged",
      parent_state_version: "v1",
    });

    const updates: ProgressUpdate[] = [];
    const stats = await stubifyGlob(root, "**", repo, silentLogger, defaultHashRunner, 4, (u) =>
      updates.push({ ...u }),
    );

    expect(stats.stubified).toBe(1);
    expect(updates.every((u) => u.bytesTotal === 0 && u.bytesDone === 0)).toBe(true);
    expect(updates.at(-1)).toMatchObject({ filesDone: 1, filesTotal: 1, totalsFinal: true });
  });

  it("settles an enumeration that over-counted because the file vanished mid-run", async () => {
    // The TOCTOU case settle() exists for: the counting pass sees a file
    // that needs rehashing, then it's gone before the real pass reaches it.
    trackedFileNeedingRehash("a.txt", "a".repeat(100));

    const hashRunner: HashRunner = {
      run: async (absolutePath) => {
        return hashFile(absolutePath);
      },
    };

    const updates: ProgressUpdate[] = [];
    const statsPromise = stubifyGlob(root, "**", repo, silentLogger, hashRunner, 1, (u) => {
      // Delete it the instant the enumeration has published its estimate,
      // before the producer loop has stat'd it.
      if (u.bytesTotal === 100 && fs.existsSync(path.join(root, "a.txt"))) {
        fs.rmSync(path.join(root, "a.txt"));
      }
      updates.push({ ...u });
    });

    const stats = await statsPromise;
    expect(stats.alreadyStub).toBe(1);
    expect(stats.stubified).toBe(0);

    // The estimate said 100 bytes; nothing was ever read. settle() brings
    // the denominator back to what actually happened so the bar lands on
    // 100% instead of stalling at 0/100.
    expect(updates.some((u) => u.bytesTotal === 100)).toBe(true);
    expect(updates.at(-1)).toMatchObject({
      bytesDone: 0,
      bytesTotal: 0,
      filesDone: 1,
      filesTotal: 1,
      totalsFinal: true,
    });
  });
});
