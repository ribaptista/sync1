#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("sync1")
  .description("E2E-encrypted, deduplicated, incremental backup CLI")
  .version("0.1.0")
  .option("--json", "output machine-readable JSON on stdout")
  .option("--verbose", "enable debug-level logging on stderr");

// Commands are registered here as they're implemented, task by task.
// Each command module reads global flags via `command.optsWithGlobals()`
// and constructs its own logger via createLogger(opts.verbose) from ./logger.js.

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});
