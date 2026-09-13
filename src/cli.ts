#!/usr/bin/env node
import { Command } from "commander";
import { registerInitRemoteCommand } from "./commands/init_remote.js";
import { registerAttachRemoteCommand } from "./commands/attach_remote.js";
import { registerUpdateCacheCommand } from "./commands/update_cache.js";
import { registerSyncCommand } from "./commands/sync.js";
import { registerFetchRemoteCommand } from "./commands/fetch_remote.js";
import { registerMaterializeCommand } from "./commands/materialize.js";
import { registerStubifyCommand } from "./commands/stubify.js";
import { registerInspectCommand } from "./commands/inspect.js";
import { registerGcCommand } from "./commands/gc.js";
import { registerIgnoreCommand } from "./commands/ignore.js";
import { registerSanityCheckCommand } from "./commands/sanity_check.js";
import { registerStoragePolicyCommand } from "./commands/storage_policy.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerConvergeCommand } from "./commands/converge.js";

const program = new Command();

program
  .name("sync1")
  .description("E2E-encrypted, deduplicated, incremental backup CLI")
  .version("0.1.0")
  .option("--json", "output machine-readable JSON on stdout")
  .option("--verbose", "enable debug-level logging on stderr")
  .option(
    "--s3-metadata-parallelism <n>",
    "max concurrent bare S3 calls (HEAD/copy/restore/delete) -- default 8",
  )
  .option(
    "--hash-parallelism <n>",
    "max concurrent file-hashing worker threads -- default: cpu count",
  )
  .option(
    "--file-stream-parallelism <n>",
    "max concurrent encrypt+upload / download+decrypt pipelines -- default 4",
  )
  .option("--no-progress", "disable progress bars even on a real terminal");

registerInitRemoteCommand(program);
registerAttachRemoteCommand(program);
registerUpdateCacheCommand(program);
registerSyncCommand(program);
registerFetchRemoteCommand(program);
registerMaterializeCommand(program);
registerStubifyCommand(program);
registerInspectCommand(program);
registerGcCommand(program);
registerIgnoreCommand(program);
registerSanityCheckCommand(program);
registerStoragePolicyCommand(program);
registerStatusCommand(program);
registerConvergeCommand(program);
// Further commands are registered here as they're implemented, task by task.

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});
