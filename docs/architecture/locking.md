# Per-vault lock file

## Why

Every sync1 command mutates `.sync1/state.db`/`cache.db` and/or the local filesystem tree in ways that
assume exclusive access to a given `--root` for the duration of the run. Two concurrent invocations
against the same root — an accidental double-run, or a forgotten background `sync` — is a real,
previously unguarded failure mode: two writers racing on the same SQLite connection, or a `materialize`
and a `stubify` disagreeing about whether a file is currently real or stubbed mid-flight. The lock closes
that gap cheaply, following the tool's existing fully-per-root design (`cache.db`/`state.db` already live
under `<root>/.sync1/`, never anywhere shared across roots).

## Shape and location

The lock is a single file at `<root>/.sync1/lock`, one per vault root — never a global, machine-wide
lock. Its content is a small JSON object:

```json
{ "pid": 12345, "acquiredAt": "2026-01-01T00:00:00.000Z", "hostname": "my-laptop" }
```

`pid` is the only field that actually drives behavior (see below); `acquiredAt`/`hostname` are purely
diagnostic, surfaced in the error message when a live lock blocks a new invocation.

## Advisory, not `flock`/`O_EXCL`

Acquiring the lock is a plain read-then-write: read any existing lock file, decide whether it's live or
stale, then write a new one. This is deliberately **advisory**, not an atomic OS-level primitive
(`flock(2)`, `O_EXCL`) — a narrow race window exists between two processes starting at almost exactly the
same moment, where both could observe "no lock" and both proceed to write one. This is an accepted,
documented limitation: the goal is catching the overwhelmingly common case (an accidental second run, or
resuming after a crash), not providing a distributed-lock guarantee. See `test/unit/vault/lock.test.ts`
and `test/e2e/lock.test.ts` for what's actually verified.

**Staleness check**: `process.kill(pid, 0)` — sends no actual signal, just tests whether a process with
that pid exists and is signalable. Throwing `ESRCH` means the process is gone; the lock is stale and safe
to overwrite. Succeeding, or throwing any other error (e.g. `EPERM` — the pid exists but belongs to a
different user), means the lock is live; the new invocation fails immediately, naming the holding pid and
acquisition time.

A lock file that fails to parse as the expected JSON shape is **never** treated as stale — `acquireLock`
throws a plain `Error` telling the user to inspect/remove it by hand instead. Silently overwriting
something whose shape isn't recognized is exactly the kind of failure mode this project avoids elsewhere
(see the stub-format and manifest-parsing error handling for the same discipline).

## Wiring: one `preAction`/`postAction` hook pair, not per-command boilerplate

`src/cli.ts` acquires and releases the lock via commander's `program.hook("preAction"/"postAction", ...)`
— registered once on the root `program`, not duplicated in every command file. This was verified directly
against commander's own source (`node_modules/commander/lib/command.js`) rather than assumed: hooks
registered on `program` fire for every nested subcommand's action too (commander walks from the leaf
action command up through its ancestors to collect applicable hooks), and `postAction` is chained via a
success-only `.then()` — so it fires after a successful action, and after a command's own
internally-handled error (every command in this codebase wraps its whole body in try/catch and never lets
its action promise reject), but correctly does **not** fire if `preAction` itself threw (there's nothing
to release in that case).

`init_remote`/`attach_remote` are the two exceptions, excluded from the generic hook by name
(`LOCK_EXEMPT_COMMANDS` in `src/cli.ts`): `.sync1/` doesn't exist yet when `preAction` fires for them, so
they manage the lock manually, right after creating `.sync1/` themselves. This surfaced and fixed a real
pre-existing latent bug in both commands: the "already initialized/attached" guard used to check whether
the `.sync1/` _directory_ existed — but creating that directory earlier (to hold the lock before any
network work) means a failed attempt (bad password, non-empty bucket, a CAS conflict) would leave a bare
`.sync1/` around, permanently blocking every future retry against that same root. The fix, independent of
locking itself: check for `vault.json`'s existence instead — it's only ever written at the very end of a
successful run, so a bare `.sync1/` left by a prior failure never blocks a retry. See
`test/e2e/init_remote.test.ts`'s "recovers from a bare .sync1/ left by a prior failed attempt" test.

## Ctrl+C: warn, force-release, exit immediately

`SIGINT`/`SIGTERM` handlers in `src/cli.ts` do exactly three things, in order: write a one-line warning to
stderr ("may leave the vault in an unfinished state"), best-effort-delete whatever lock _this process
itself_ holds, and `process.exit(128 + signum)`. There is deliberately no draining of in-flight pool work
and nothing else is awaited — per the explicit design goal, a user hitting Ctrl+C shouldn't have to think
about "is it safe to interrupt this," only "did it warn me, and is the lock gone so I can retry." A
half-finished operation _in the working tree_ (a stub materialized but not yet renamed into place, a
mid-upload connection cut) is always left in a state the next `update_cache`/`sanity_check` can detect
and reconcile — that's a property of the surrounding stub/materialize/sync design (see
[stub-files.md](stub-files.md)), not something the signal handler itself needs to guarantee.

Two other kinds of leftovers from a killed `process.exit()` — no `finally` runs on the way out — are
_not_ self-healing the same way, and needed their own fix:

- **A `.sync1/`-internal temp DB.** `commit.ts`'s CAS commit (and the generic mutate-with-retry helper,
  `gc`'s orphan staging, `update_cache`'s own staging pass) all write to a `tempSiblingPath` sibling —
  `state.db.candidate-<hex>`, `state.db.remote-fresh-<hex>`, `cache.db.update-cache-staging-<hex>`, and
  so on — deleted in a `finally` that Ctrl+C skips. Nothing else in the codebase ever revisits these
  filenames, so they'd otherwise sit there permanently. `sweepStaleTempFiles` (`src/fs/temp-path.ts`) —
  called from `src/cli.ts`'s `preAction` hook, right after `acquireLock()` succeeds and before any
  command-specific code runs — removes every file in `.sync1/` matching the shape `tempSiblingPath`
  produces (including a `-shm`/`-wal` sidecar, for one caught mid-WAL-checkpoint). Safe specifically
  _because_ it only ever runs once the lock is confirmed held: that's what guarantees every such file is
  trash from a past, no-longer-running attempt, never a live sibling some other process still owns.
- **An in-tree download/stub-write temp.** `apply-remote-changes.ts`, `materialize.ts`, and `stub.ts` all
  write to an `inTreeTempPath` sibling (`<file>.sync1-tmp-<hex>`) right next to the real destination,
  renamed into place only on success. Unlike the `.sync1/`-internal case, this one _is_ self-healing on
  its own (nothing ever references the half-written temp again, and the next run's own logic doesn't
  depend on it) — the actual bug was that the walker never excluded it at all (only literal `.sync1` at
  the root was ever excluded), so a leftover used to be picked up by the next `update_cache` as a
  genuine new file and synced. `walk()` (`src/fs/walker.ts`) now excludes any name matching
  `inTreeTempPath`'s own shape, at any depth — not swept or deleted, just never reported as a tracked
  path, so it's harmless clutter rather than phantom content.

This also fixed a real bug in the lock acquisition itself, found while wiring the sweep in: `preAction`
used to check the _raw_ `--root` flag directly and silently skip locking altogether (no error) when it
was omitted — exactly the common case `--root`'s ancestor-lookup default (`resolveRoot`, see
`docs/cli/`) exists to support. It now resolves the same way every command's own action handler does,
before acquiring the lock.

The stderr write uses `fs.writeSync(2, ...)`, not `process.stderr.write(...)` — a stderr write to a
pipe/socket is documented as _asynchronous_ on POSIX, so the `process.exit()` right after could otherwise
race ahead of it and silently drop the warning. `writeSync` to fd 2 is a genuine synchronous syscall on
every platform, guaranteeing the message is flushed before the process exits.

The lock a process force-releases is tracked in a small module-level slot in `src/vault/lock.ts`
(`activeLockPaths`), not looked up freshly from disk — this process only ever needs to clean up a lock it
itself is holding, never anyone else's.

## Errors and exit codes

A live lock (or a `preAction`-thrown error of any kind, which never reaches a command's own try/catch)
surfaces via a new `VaultLockedError extends Error`, mapped to `EXIT_CONFLICT` (2) in
`src/cli/output.ts`'s `exitCodeForError` — conceptually the same class of thing as a `RemoteDivergedError`
(another actor doing something incompatible with this run), not a generic (1) or corruption (3) failure.
`src/cli.ts`'s top-level `.catch(...)` was upgraded from a raw stderr write to `emitError(json, message,
exitCodeForError(err))` specifically so this error gets the same `--json`/text formatting and exit code
as every other error, even though it originates from a hook rather than a command's own action.
