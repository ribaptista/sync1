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
});
