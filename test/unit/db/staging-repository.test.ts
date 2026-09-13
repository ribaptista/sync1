import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { StagingRepository } from "../../../src/db/repositories/staging-repository.js";

let dir: string;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("StagingRepository", () => {
  it("creates a real file on disk at the given path", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-staging-test-"));
    const filePath = path.join(dir, "staging.db");
    const staging = new StagingRepository(filePath);
    expect(fs.existsSync(filePath)).toBe(true);
    staging.close();
  });

  it("round-trips inserted rows through iterateAll", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-staging-test-"));
    const staging = new StagingRepository(path.join(dir, "staging.db"));

    staging.insert({
      path: "a.txt",
      type: "file",
      mtime: 123,
      hash: "abc",
      state: "created",
      parent_state_version: "v0",
    });
    staging.insert({
      path: "b.txt",
      type: "file",
      mtime: null,
      hash: null,
      state: "deleted",
      parent_state_version: "v0",
    });

    const rows = [...staging.iterateAll()].sort((x, y) => x.path.localeCompare(y.path));
    expect(rows).toEqual([
      {
        path: "a.txt",
        type: "file",
        mtime: 123,
        hash: "abc",
        state: "created",
        parent_state_version: "v0",
      },
      {
        path: "b.txt",
        type: "file",
        mtime: null,
        hash: null,
        state: "deleted",
        parent_state_version: "v0",
      },
    ]);
    staging.close();
  });

  it("iterateAll paginates across page boundaries without holding the connection open", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-staging-test-"));
    const staging = new StagingRepository(path.join(dir, "staging.db"));

    for (let i = 0; i < 5; i++) {
      staging.insert({
        path: `file-${i}.txt`,
        type: "file",
        mtime: i,
        hash: `hash-${i}`,
        state: "created",
        parent_state_version: "v0",
      });
    }

    // Interleaving another query on the same connection mid-stream must not
    // throw "database is busy" -- proving the connection is genuinely free
    // between pages, not just that a small page size happens to be enough.
    const seen: string[] = [];
    for (const row of staging.iterateAll()) {
      seen.push(row.path);
      expect(staging.isDeletedInBatch(row.path)).toBe(false);
    }
    expect(seen.sort()).toEqual([
      "file-0.txt",
      "file-1.txt",
      "file-2.txt",
      "file-3.txt",
      "file-4.txt",
    ]);
    staging.close();
  });

  it("isDeletedInBatch reports true only for staged tombstones, false otherwise", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-staging-test-"));
    const staging = new StagingRepository(path.join(dir, "staging.db"));

    staging.insert({
      path: "gone.txt",
      type: "file",
      mtime: null,
      hash: null,
      state: "deleted",
      parent_state_version: "v0",
    });
    staging.insert({
      path: "here.txt",
      type: "file",
      mtime: 1,
      hash: "abc",
      state: "created",
      parent_state_version: "v0",
    });

    expect(staging.isDeletedInBatch("gone.txt")).toBe(true);
    expect(staging.isDeletedInBatch("here.txt")).toBe(false);
    expect(staging.isDeletedInBatch("never-staged.txt")).toBe(false);
    staging.close();
  });
});
