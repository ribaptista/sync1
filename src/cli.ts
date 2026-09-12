#!/usr/bin/env node
import { Command } from "commander";
import { registerInitRemoteCommand } from "./commands/init_remote.js";
import { registerAttachRemoteCommand } from "./commands/attach_remote.js";
import { registerUpdateCacheCommand } from "./commands/update_cache.js";
import { registerSyncCommand } from "./commands/sync.js";
import { registerFetchRemoteCommand } from "./commands/fetch_remote.js";
import { registerEnsureStorageClassCommand } from "./commands/ensure_storage_class.js";
import { registerMaterializeCommand } from "./commands/materialize.js";
import { registerStubifyCommand } from "./commands/stubify.js";

const program = new Command();

program
  .name("sync1")
  .description("E2E-encrypted, deduplicated, incremental backup CLI")
  .version("0.1.0")
  .option("--json", "output machine-readable JSON on stdout")
  .option("--verbose", "enable debug-level logging on stderr");

registerInitRemoteCommand(program);
registerAttachRemoteCommand(program);
registerUpdateCacheCommand(program);
registerSyncCommand(program);
registerFetchRemoteCommand(program);
registerEnsureStorageClassCommand(program);
registerMaterializeCommand(program);
registerStubifyCommand(program);
// Further commands are registered here as they're implemented, task by task.

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});
