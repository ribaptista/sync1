import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";

const PASSWORD = "correct horse battery staple";
const PROJECT_ROOT = process.cwd();
const CLI_ENTRY = path.join(PROJECT_ROOT, "src", "cli.ts");
// Same `--require`/`--import` flags the `tsx` binary itself passes to `node`
// (verified directly against node_modules/tsx/dist/cli.mjs's own spawn call).
// Used here instead of shelling out to the `tsx` bin so that *this* process
// -- not a wrapper -- is the one running cli.ts: `tsx` is a wrapper that
// forks a *grandchild* node process to actually run the script, and forwards
// signals to it through its own ack-based relay, force-SIGKILLing the
// grandchild if it doesn't hear back within ~60ms. That escalation can race
// a real signal handler doing any nontrivial synchronous work at the moment
// the signal arrives (e.g. `sync`'s Argon2id KDF pass), killing the process
// before our own handler gets to run -- reproducible even with a generous
// pre-signal delay under load. Invoking node directly sidesteps the relay
// entirely and is also a closer match for production: the real `bin` entry
// point (`dist/cli.js`) is a single plain node process with no wrapper.
const TSX_PREFLIGHT = path.resolve(PROJECT_ROOT, "node_modules/tsx/dist/preflight.cjs");
const TSX_LOADER = pathToFileURL(
  path.resolve(PROJECT_ROOT, "node_modules/tsx/dist/loader.mjs"),
).toString();

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-lock-"));
}

function lockPath(root: string): string {
  return path.join(root, ".sync1", "lock");
}

/** Polls until `predicate()` is true, or throws after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Spawns the CLI as a real, still-running child process (not wait-for-completion). */
function spawnCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawn(
    process.execPath,
    ["--require", TSX_PREFLIGHT, "--import", TSX_LOADER, CLI_ENTRY, ...args],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
    },
  );
}

describe("per-vault lock", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("rejects a command immediately when a pre-seeded live lock exists, leaving the lock untouched", async () => {
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

    // Pre-seed a lock naming THIS test process's own pid -- guaranteed alive.
    const lockContent = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      hostname: "test-host",
    };
    fs.writeFileSync(lockPath(root), JSON.stringify(lockContent));

    const result = await runCli(["update_cache", "--root", root, "--json"]);
    expect(result.exitCode).toBe(2); // EXIT_CONFLICT
    const parsed = JSON.parse(result.stdout) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(new RegExp(`locked by pid ${process.pid}`));

    // The lock file is untouched -- a rejected acquisition never overwrites it.
    expect(JSON.parse(fs.readFileSync(lockPath(root), "utf8"))).toEqual(lockContent);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects a real second concurrent invocation while the first is still running, and clears the lock once it exits", async () => {
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
    // Real file content to hash/encrypt/upload -- gives the first `sync` a
    // reliably wide time window to still be running (on top of the vault
    // password's own ~250-450ms Argon2id KDF pass and the real LocalStack
    // round-trips), rather than depending on KDF/network timing alone. 200
    // (not 40): under a full-suite run's CPU contention, this test's own
    // `waitFor` polling loop lags too, eating into the margin between "lock
    // file observed" and "first process finishes" -- 200 was empirically
    // wide enough to stop that observed flake, still fast in isolation.
    for (let i = 0; i < 200; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), `content of file ${i}`.repeat(2000));
    }

    const first = spawnCli(["sync", "--root", root, "--json"], { SYNC1_PASSWORD: PASSWORD });
    let firstExitCode: number | null = null;
    first.on("close", (code) => {
      firstExitCode = code;
    });

    await waitFor(() => fs.existsSync(lockPath(root)));

    const second = await runCli(["update_cache", "--root", root, "--json"]);
    expect(second.exitCode).toBe(2);
    const secondParsed = JSON.parse(second.stdout) as { ok: boolean; error: string };
    expect(secondParsed.error).toMatch(/locked by pid/);

    await waitFor(() => firstExitCode !== null, 20000);
    expect(firstExitCode).toBe(0);
    expect(fs.existsSync(lockPath(root))).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("SIGINT to a running invocation prints a warning, exits 130, and removes the lock", async () => {
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
    // Real file content, same as the concurrent-invocation test above -- gives
    // `sync` a reliably wide window of real work (hashing/encrypting/
    // uploading) to still be in progress once we send SIGINT.
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), `content of file ${i}`.repeat(2000));
    }

    const child = spawnCli(["sync", "--root", root, "--json"], { SYNC1_PASSWORD: PASSWORD });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // "close" (not "exit"): fires only once every stdio stream has finished
    // flushing, so `stderr` below is guaranteed complete by the time we check it.
    const exitPromise = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });

    await waitFor(() => fs.existsSync(lockPath(root)));
    child.kill("SIGINT");

    const exitCode = await exitPromise;
    expect(exitCode).toBe(130);
    expect(stderr).toMatch(/received SIGINT/);
    expect(stderr).toMatch(/unfinished state/);
    expect(fs.existsSync(lockPath(root))).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
