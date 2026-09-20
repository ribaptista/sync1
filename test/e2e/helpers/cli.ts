import { execFile } from "node:child_process";
import path from "node:path";

// Resolved once, from the project root vitest runs in — independent of
// whatever `cwd` an individual test passes for the CLI's own working
// directory (e.g. a temp "local root" folder for filesystem-facing commands).
const PROJECT_ROOT = process.cwd();
const TSX_BIN = path.join(PROJECT_ROOT, "node_modules", ".bin", "tsx");
const CLI_ENTRY = path.join(PROJECT_ROOT, "src", "cli.ts");

/**
 * Node's default is 1 MiB, and exceeding it makes Node SIGTERM the child and
 * hand back truncated output. The `*_concurrency.test.ts` files deliberately
 * drive large `--verbose` stderr to count `{pool, inFlight, queued}` events,
 * so they sit near that edge by design — and a truncated sample would make
 * their `max(inFlight) <= limit` assertions pass *more* easily, weakening the
 * very thing they exist to prove.
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Last few lines of output, for an error message that has to stay readable. */
function tail(text: string, lines = 10): string {
  const trimmed = text.trimEnd();
  if (trimmed === "") return "(empty)";
  return trimmed.split("\n").slice(-lines).join("\n");
}

/**
 * Spawns the CLI as a real, separate process (via tsx, so no build step is
 * required between edits and test runs) — true black-box invocation, same
 * argv/stdio a user would get.
 *
 * **A numeric exit code is data; anything else is a thrown error.** This
 * used to collapse every non-numeric `error.code` to `1`, which is a
 * meaningful value in this CLI (`EXIT_GENERIC_ERROR`), so "the CLI ran and
 * rejected your input" became indistinguishable from "the OS killed it"
 * (signal kill: `code` undefined, `signal` set), "it never started"
 * (`ENOENT`: `code` is a string) and "Node truncated its output and killed
 * it" (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`).
 *
 * The visible cost is a false *failure*: the better-sqlite3 teardown
 * SIGABRT documented in docs/platform-setup.md surfaces as
 * `expected 1 to be 0` with empty stdout, which has twice sent someone
 * looking for a regression that wasn't there.
 *
 * The quieter cost is a false *pass*, and it is worth stating precisely
 * rather than dramatically. Some thirty assertions here check only that an
 * exit code is non-zero — `expect(result.exitCode).not.toBe(0)` — and a
 * SIGABRT satisfies that exactly as well as the validation under test does.
 * A *persistently* broken CLI can't exploit this, because nearly every such
 * test runs setup calls first (`init_remote`, a seeding `create`) that
 * assert success and would trip immediately; this was measured, not assumed.
 * What slips through is an *intermittent, per-process* kill landing on the
 * one invocation whose failure is being asserted — which is the exact shape
 * of that teardown abort.
 *
 * It matters more now than it did: with the e2e project's per-test timeout
 * removed (see vitest.workspace.ts), this is the only thing left that can
 * report a child which never ran.
 */
export function runCli(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(
      TSX_BIN,
      [CLI_ENTRY, ...args],
      {
        cwd: opts.cwd ?? PROJECT_ROOT,
        env: { ...process.env, ...opts.env },
        maxBuffer: MAX_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        try {
          resolve(classifyCliOutcome(args, error, stdout, stderr));
        } catch (err) {
          reject(err as Error);
        }
      },
    );
  });
}

/**
 * The decision `runCli` is built on, split out so it can be tested against
 * each failure shape directly. Driving it through a real spawn would mean
 * fighting the OS for a specific `error` shape -- notably, a missing *script*
 * doesn't produce `ENOENT` at all, because `tsx` is found and exits 1 with a
 * module-not-found of its own.
 *
 * Returns a result for a genuine exit code; throws for anything else.
 */
export function classifyCliOutcome(
  args: string[],
  error: (Error & { code?: unknown; signal?: NodeJS.Signals | null }) | null,
  stdout: string,
  stderr: string,
): CliResult {
  if (!error) return { exitCode: 0, stdout, stderr };
  if (typeof error.code === "number") return { exitCode: error.code, stdout, stderr };

  const cause =
    error.signal != null
      ? `killed by ${error.signal}`
      : `failed to run (${typeof error.code === "string" ? error.code : error.message})`;
  throw new Error(
    `sync1 ${args.join(" ")} ${cause}\n` +
      `  stdout: ${tail(stdout)}\n` +
      `  stderr: ${tail(stderr)}`,
  );
}
