import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runCli } from "./helpers/cli.js";
import { openStateDb } from "../../src/db/connection.js";
import { VersionsRepository } from "../../src/db/repositories/versions-repository.js";

function mkTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-uc-root-"));
  fs.mkdirSync(path.join(root, ".sync1"));
  fs.writeFileSync(path.join(root, ".sync1", "last_synced_version"), "v0", "utf8");
  // update_cache validates stub-declared hashes against state.db's objects
  // table (read-only, no password needed since it's already decrypted on
  // disk) -- so even this offline, no-S3 test needs a real (if empty) one.
  const stateDb = openStateDb(path.join(root, ".sync1", "state.db"));
  new VersionsRepository(stateDb).insert("v0", new Date().toISOString());
  stateDb.close();
  return root;
}

function readCacheRows(root: string): Array<{ path: string; state: string }> {
  const db = new Database(path.join(root, ".sync1", "cache.db"), { readonly: true });
  const rows = db
    .prepare<[], { path: string; state: string }>("SELECT path, state FROM entries ORDER BY path")
    .all();
  db.close();
  return rows;
}

describe("update_cache", () => {
  it("detects created, modified, and deleted files across successive runs", async () => {
    const root = mkTempRoot();
    fs.writeFileSync(path.join(root, "a.txt"), "hello");
    fs.mkdirSync(path.join(root, "photos"));
    fs.writeFileSync(path.join(root, "photos", "img.jpg"), "pixels");

    const first = await runCli(["update_cache", "--root", root, "--json"]);
    expect(first.exitCode).toBe(0);
    const firstStats = JSON.parse(first.stdout) as {
      ok: boolean;
      created: number;
      modified: number;
      deleted: number;
      unchanged: number;
      case_collisions: unknown[];
    };
    expect(firstStats).toEqual({
      ok: true,
      created: 3,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      case_collisions: [],
    });

    let rows = readCacheRows(root);
    expect(rows).toEqual([
      { path: "a.txt", state: "created" },
      { path: "photos", state: "created" },
      { path: "photos/img.jpg", state: "created" },
    ]);

    // rerun with no filesystem changes -- everything already 'created'
    // stays 'created' (no sync has happened yet to establish a baseline)
    const second = await runCli(["update_cache", "--root", root, "--json"]);
    const secondStats = JSON.parse(second.stdout) as { unchanged: number };
    expect(secondStats.unchanged).toBe(3);

    // delete a file, add a new one
    fs.rmSync(path.join(root, "a.txt"));
    fs.writeFileSync(path.join(root, "new.txt"), "fresh");
    const third = await runCli(["update_cache", "--root", root, "--json"]);
    const thirdStats = JSON.parse(third.stdout) as {
      created: number;
      modified: number;
      deleted: number;
    };
    expect(thirdStats.created).toBe(1);
    expect(thirdStats.deleted).toBe(1);

    rows = readCacheRows(root);
    expect(rows).toEqual([
      { path: "a.txt", state: "deleted" },
      { path: "new.txt", state: "created" },
      { path: "photos", state: "created" },
      { path: "photos/img.jpg", state: "created" },
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fails cleanly when the root was never initialized/attached", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-uc-bare-"));
    const result = await runCli(["update_cache", "--root", root, "--json"]);
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/does not exist/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
