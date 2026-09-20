#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
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
import { registerThumbnailPolicyCommand } from "./commands/thumbnail_policy.js";
import { registerThumbnailCommand } from "./commands/thumbnail.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerConvergeCommand } from "./commands/converge.js";
import { acquireLock, forceReleaseActiveLockSync, type LockHandle } from "./vault/lock.js";
import { emitError, exitCodeForError, EXIT_GENERIC_ERROR } from "./cli/output.js";

const program = new Command();

// init_remote/attach_remote manage their own lock lifecycle internally --
// `.sync1/` doesn't exist yet when `preAction` fires for them, so the
// generic hook below must not try to acquire a lock inside it.
const LOCK_EXEMPT_COMMANDS = new Set(["init_remote", "attach_remote"]);

let currentLock: LockHandle | undefined;

program.hook("preAction", (_thisCommand, actionCommand) => {
  if (LOCK_EXEMPT_COMMANDS.has(actionCommand.name())) return;
  const opts = actionCommand.opts() as { root?: string };
  if (!opts.root) return; // defensive: every command that needs the lock also requires --root
  currentLock = acquireLock(path.resolve(opts.root));
});

program.hook("postAction", (_thisCommand, actionCommand) => {
  if (LOCK_EXEMPT_COMMANDS.has(actionCommand.name())) return;
  currentLock?.release();
  currentLock = undefined;
});

function handleTerminationSignal(signal: "SIGINT" | "SIGTERM"): void {
  // fs.writeSync (not process.stderr.write) deliberately: a stderr write to
  // a pipe/socket is documented as *asynchronous* on POSIX, so the
  // process.exit() right below could otherwise race ahead of it and drop
  // this warning entirely -- writeSync to fd 2 is synchronous on every
  // platform, guaranteeing it's flushed before we exit.
  fs.writeSync(
    2,
    `\nsync1: received ${signal} -- exiting immediately; the vault may be left in an unfinished state (in-flight work is not awaited)\n`,
  );
  forceReleaseActiveLockSync();
  process.exit(signal === "SIGINT" ? 130 : 143);
}
process.on("SIGINT", () => handleTerminationSignal("SIGINT"));
process.on("SIGTERM", () => handleTerminationSignal("SIGTERM"));

// A defensive backstop, not the primary fix -- every dispatch loop in this
// codebase should already route its pool's task failures through
// dispatchTracked/throwIfPoolErrored (src/concurrency/pools.ts) rather than
// discarding `void pool.add(...)`'s own promise, which is what used to let
// a single failed task crash the whole process with a raw, uncaught stack
// trace: bypassing the failing command's own try/catch, `emitError`, and
// lock release entirely (see the `program.parseAsync(...).catch(...)`
// handler at the bottom of this file, which only ever sees an error that
// actually propagates through commander's own action-invocation chain --
// a detached, fire-and-forgotten task's rejection is never part of that
// chain at all). This exists so a *future* path that reintroduces that
// pattern fails cleanly here instead of silently reverting to a crash.
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const json = (program.opts() as { json?: boolean }).json ?? false;
  // fs.writeSync (not emitError's process.stdout/stderr.write), same
  // reasoning as handleTerminationSignal above: a pipe/socket write is
  // documented as *asynchronous* on POSIX, so the process.exit() right
  // below could otherwise race ahead of it and drop this message entirely.
  if (json) {
    fs.writeSync(
      1,
      `${JSON.stringify({ ok: false, error: message })}
`,
    );
  } else {
    fs.writeSync(
      2,
      `
sync1: unhandled internal error -- ${message}
`,
    );
  }
  forceReleaseActiveLockSync();
  process.exit(exitCodeForError(reason) ?? EXIT_GENERIC_ERROR);
});

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
  .option(
    "--thumbnail-parallelism <n>",
    "max concurrent thumbnail/mosaic generation jobs -- default 4",
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
registerThumbnailPolicyCommand(program);
registerThumbnailCommand(program);
registerStatusCommand(program);
registerConvergeCommand(program);
// Further commands are registered here as they're implemented, task by task.

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const json = (program.opts() as { json?: boolean }).json ?? false;
  emitError(json, message, exitCodeForError(err));
});
