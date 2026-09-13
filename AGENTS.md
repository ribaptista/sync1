# Contributor / agent guidance for sync1

## Definition of done

A task (in the sense of the tasks laid out in the project plan) is **not complete** until all of the
following pass, in this order:

1. `npm run typecheck` (`tsc --noEmit` — tests run via `tsx`, which transpiles but does not type-check,
   so this is the only thing that actually catches a type error)
2. `npm run lint` (ESLint, zero warnings)
3. `npm run format:check` (Prettier)
4. `npm run test:unit`
5. `npm run test:e2e`

`npm run verify` runs all five in order in one command.

This is enforced locally by a `husky` pre-commit hook (`lint-staged`: `eslint --fix` + `prettier --write`
on staged files), but pre-commit only covers staged-file lint/format — it does **not** run the test
suites. Running the full definition-of-done list above before considering any task finished is a manual
step, not something the hook does for you.

Do not mark a task done, move to the next task, or say a feature "works" without having actually run
all four of the above to completion.

## Conventions this repo follows

- **SQL lives only in `src/db/repositories/`.** No raw SQL strings anywhere else in the codebase.
- **One file per CLI command**, under `src/commands/`.
- **Migrations are append-only.** Never edit a migration file that's already been merged — add a new
  numbered one instead.
- **Hashes/digests are always hex-encoded strings in SQLite**, never raw binary columns.
- **Never hold a blocking DB cursor open.** Use keyset/seek pagination (`WHERE <key> > ? ORDER BY <key>
LIMIT N`, never `OFFSET`) for SQLite queries that scan a table, not `.iterate()` — a live `.iterate()`
  cursor holds its underlying statement open between `.next()` calls, forbidding any other statement on
  that connection until it's exhausted; a paginated generator (`.all()` per page) hands back the
  identical `IterableIterator<T>` shape with the connection fully free between pages. Stream the
  filesystem walk the same way. See `src/db/keyset-pagination.ts` and
  `docs/architecture/cache-and-filesystem-scanning.md`.
- **Before writing code that accumulates an unknown number of items into memory** (an array/Set/Map
  built from a table scan, glob match, or filesystem walk, or any working set whose size isn't obviously
  bounded by a small constant or by direct one-to-one user input) — **stop and ask the user** whether
  that set is actually bounded in practice (some are: a dedup group sharing one content hash, a
  user-managed policy list) before either writing the accumulation or reflexively converting it to a
  streaming/paginated form. Don't assume either way.
- **Every keyset-paginated query must have a matching index covering both its filter and its ordering
  column(s)** — an index that only serves the filter (forcing a separate sort step) defeats the point of
  pagination.
- **Every command with a per-item loop parallelizes both discovery and execution, with explicit
  backpressure.** Discovering items (walking the filesystem, paginating a table) runs concurrently with a
  bounded pool of job workers processing items already discovered — but the producer must never get more
  than a small, fixed number of jobs ahead of what the pool can run; an unbounded producer feeding a pool
  is just as unbounded as loading everything into an array. See `src/concurrency/pools.ts`.
- **Every command with a per-item processing loop shows a progress bar with a live total**, except in
  `--json` or `--no-progress` mode — including when the true total isn't known upfront (the bar's total
  grows as discovery finds more). A single fast query that happens to return a list (`inspect`'s glob
  match, `ignore list`), or a one-shot command with no per-item work at all, has nothing to show progress
  on and stays as-is. See `src/cli/progress.ts`.
- **Every implemented query gets an index.**
- **Logging**: use the logger from `src/logger.ts`, always with structured context fields
  (`logger.debug({ path, hash }, "...")`), never bare string interpolation. Logs go to stderr, except
  while progress bars are actively rendering, when `--verbose` output instead goes to file descriptor 3
  if the user redirected it there (e.g. `3>/tmp/sync1.log`) — never a file the tool opens itself — so it
  never corrupts the bars occupying stderr; see `docs/architecture/concurrency-and-progress.md`.
  `--json` command output is a completely separate channel (stdout) and must never be mixed with logs.
- **`--json` on every command**, consistent output/error shape, non-zero exit code on any failure.
  Human-readable output (the non-`--json` default, with progress bars) is not covered by tests.

## Documentation

Each task in the project plan names specific `docs/cli/*.md` (user-facing command docs) and
`docs/architecture/*.md` (design-decision docs) files it must produce or update before it's done. See
the plan file for the full list per task.
