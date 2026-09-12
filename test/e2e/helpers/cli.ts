import { execFile } from "node:child_process";
import path from "node:path";

// Resolved once, from the project root vitest runs in — independent of
// whatever `cwd` an individual test passes for the CLI's own working
// directory (e.g. a temp "local root" folder for filesystem-facing commands).
const PROJECT_ROOT = process.cwd();
const TSX_BIN = path.join(PROJECT_ROOT, "node_modules", ".bin", "tsx");
const CLI_ENTRY = path.join(PROJECT_ROOT, "src", "cli.ts");

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawns the CLI as a real, separate process (via tsx, so no build step is
 * required between edits and test runs) — true black-box invocation, same
 * argv/stdio a user would get.
 */
export async function runCli(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      TSX_BIN,
      [CLI_ENTRY, ...args],
      { cwd: opts.cwd ?? PROJECT_ROOT, env: { ...process.env, ...opts.env } },
      (error, stdout, stderr) => {
        let exitCode = 0;
        if (error) {
          exitCode = typeof error.code === "number" ? error.code : 1;
        }
        resolve({ exitCode, stdout, stderr });
      },
    );
  });
}
