# Flow: command preamble and lock

**Derived from:** `src/cli.ts`, `src/cli/resolve-root.ts`, `src/vault/lock.ts`, `src/fs/temp-path.ts`

**Used by:** every command file in this directory except `init_attach.md`, which takes its own lock
instead of going through this hook.

Every command except `init_remote`/`attach_remote` runs the same four steps before its own handler body
executes at all: resolve the root, take the vault lock, sweep stale temp files, then (after the handler
returns or throws) release the lock. This is Commander's `preAction`/`postAction` hook pair in
`src/cli.ts`, registered once for the whole program.

## Sequence

```mermaid
sequenceDiagram
    participant User
    participant Commander as Commander (preAction)
    participant CLI as command handler
    participant Lock as .sync1/lock
    participant FS

    User->>Commander: sync1 <command> [--root <path>]
    alt actionCommand.name() is init_remote or attach_remote
        Commander->>CLI: run handler directly (no lock)
        note over Commander: LOCK_EXEMPT_COMMANDS -- see init_attach.md,<br/>which manages its own lock
    else every other command
        Commander->>Commander: resolveRoot(opts.root)
        alt --root given
            Commander->>FS: path.resolve(root); assertAttached (existsSync .sync1/)
            FS-->>Commander: throws if .sync1/ missing
        else --root omitted
            Commander->>FS: findAncestorWithSync1(cwd) -- walk up, existsSync per level
            FS-->>Commander: throws if none found
        end
        Commander->>Lock: acquireLock(root)
        Lock->>FS: readExistingLock() -- fs.readFileSync(.sync1/lock)
        alt lock file present and its pid is alive (process.kill(pid, 0))
            Lock-->>Commander: throw VaultLockedError
            Commander-->>User: exit code 2
        else absent, malformed, or stale
            Lock->>FS: write tempSiblingPath(lock) -> renameSync onto .sync1/lock
            Lock->>Lock: activeLockPaths.add(lockPath)
        end
        Commander->>FS: sweepStaleTempFiles(.sync1/) -- rm files matching<br/>/\.[a-z][a-z-]*-[0-9a-f]{8}(-shm|-wal)?$/, best-effort
        Commander->>CLI: run handler
        CLI-->>Commander: return, or throw
        Commander->>Lock: postAction -> lock.release()
        Lock->>FS: re-read .sync1/lock; remove only if pid === process.pid
    end
```

## Notes

- **Concurrency:** none of this is concurrent; it is strictly sequential setup that runs once per
  invocation, before any pool exists.
- **Every command re-resolves its own root a second time**, independently, inside its own action
  handler — the hook's `resolveRoot` at step 2 is a distinct, redundant resolution from the one each
  command file's own trace begins with. Both must agree, since they read the same `--root`/cwd, but
  this is worth knowing when reading a command file: "resolve root" happens twice, not once.
- **On failure:**
  - A held lock (another live process) throws `VaultLockedError` before anything else runs — no temp
    files, no DB opens, exit code 2.
  - **Signals bypass all of this cleanup.** `SIGINT`/`SIGTERM` handlers call
    `forceReleaseActiveLockSync()` directly and `process.exit(130|143)` — no `finally` blocks run, so a
    candidate DB or a marker file mid-write is left exactly as it was. The `unhandledRejection` handler
    does the same: `fs.writeSync` the error, force-release the lock, `process.exit`.
  - The next command's `sweepStaleTempFiles` step is what cleans up the temp files (not markers, not
    candidate DBs — only `.sync1/`-internal names matching the sweep pattern) a killed process left
    behind.
- **Sub-flows:** none — this is itself a flow file, the common prologue every command diagram in this
  directory begins after.
