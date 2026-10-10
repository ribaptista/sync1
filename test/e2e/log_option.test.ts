import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { openStateDb } from "../../src/db/connection.js";
import { VersionsRepository } from "../../src/db/repositories/versions-repository.js";

/**
 * A minimal, valid .sync1/ -- same recipe resolve_root.test.ts's own
 * `mkVaultRoot` uses -- for `update_cache`, which needs no S3 access and no
 * password at all.
 */
function mkVaultRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-log-option-"));
  fs.mkdirSync(path.join(root, ".sync1"));
  fs.writeFileSync(path.join(root, ".sync1", "last_synced_version"), "v0", "utf8");
  const stateDb = openStateDb(path.join(root, ".sync1", "state.db"));
  new VersionsRepository(stateDb).insert("v0", new Date().toISOString());
  stateDb.close();
  return root;
}

/**
 * `runCli` spawns the CLI as a real child process with stdio piped (see
 * test/e2e/helpers/cli.ts), never a real TTY -- so `shouldShowProgress` is
 * always false here, regardless of `--progress`/`--no-progress`. That's
 * exactly the case these tests cover: `--log` only ever matters once
 * progress bars are actually going to show (see
 * `openRunLogIfShowingProgress`'s own doc comment in
 * src/cli/progress.ts) -- without a TTY it must always be a silent no-op,
 * covered end-to-end here against a real spawned process, not just the
 * unit-level fake `showProgress` booleans.
 */
describe("--log (no real TTY, so progress bars never show)", () => {
  it("is ignored, and never creates the file, when the path is perfectly valid", async () => {
    const root = mkVaultRoot();
    const logPath = path.join(root, "sync1.log");

    const result = await runCli([
      "update_cache",
      "--root",
      root,
      "--json",
      "--verbose",
      "--log",
      logPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(logPath)).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is ignored, and does not fail the run, even when the path's directory doesn't exist", async () => {
    const root = mkVaultRoot();
    const logPath = path.join(root, "no-such-directory", "sync1.log");

    const result = await runCli([
      "update_cache",
      "--root",
      root,
      "--json",
      "--verbose",
      "--log",
      logPath,
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(fs.existsSync(logPath)).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is accepted as a global flag before or after the subcommand", async () => {
    const root = mkVaultRoot();
    const logPath = path.join(root, "sync1.log");

    const result = await runCli(["--log", logPath, "update_cache", "--root", root, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(logPath)).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
