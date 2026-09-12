import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runCli } from "./helpers/cli.js";
import { openStateDb } from "../../src/db/connection.js";
import { VersionsRepository } from "../../src/db/repositories/versions-repository.js";

function mkTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-case-"));
  fs.mkdirSync(path.join(root, ".sync1"));
  fs.writeFileSync(path.join(root, ".sync1", "last_synced_version"), "v0", "utf8");
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

describe("update_cache: case-insensitive collision (local scan)", () => {
  it("reports a same-directory collision for both paths, applies everything else", async () => {
    const root = mkTempRoot();
    fs.writeFileSync(path.join(root, "file.txt"), "one");
    fs.writeFileSync(path.join(root, "FILE.txt"), "two");
    fs.writeFileSync(path.join(root, "other.txt"), "unrelated");

    const result = await runCli(["update_cache", "--root", root, "--json"]);
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      case_collisions: Array<{ path: string; collides_with: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.case_collisions).toHaveLength(2);
    const collidingPaths = parsed.case_collisions.map((c) => c.path).sort();
    expect(collidingPaths).toEqual(["FILE.txt", "file.txt"]);

    const rows = readCacheRows(root);
    expect(rows).toEqual([{ path: "other.txt", state: "created" }]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("recovers in a single run once one of the two colliding paths is removed", async () => {
    const root = mkTempRoot();
    fs.writeFileSync(path.join(root, "file.txt"), "one");
    fs.writeFileSync(path.join(root, "FILE.txt"), "two");

    const first = await runCli(["update_cache", "--root", root, "--json"]);
    expect(first.exitCode).not.toBe(0);

    // resolve by removing one of the two colliding files, then rerun once
    fs.rmSync(path.join(root, "file.txt"));
    const second = await runCli(["update_cache", "--root", root, "--json"]);
    expect(second.exitCode).toBe(0);
    const parsed = JSON.parse(second.stdout) as { ok: boolean; case_collisions: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.case_collisions).toEqual([]);

    const rows = readCacheRows(root);
    expect(rows).toEqual([{ path: "FILE.txt", state: "created" }]);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
