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
- **Never load an entire table or filesystem tree into memory.** Use `.iterate()` (not `.all()`) on
  SQLite queries that scan `entries`, and stream the filesystem walk. See
  `docs/architecture/cache-and-filesystem-scanning.md` once Task 6 lands.
- **Every implemented query gets an index.**
- **Logging**: use the logger from `src/logger.ts`, always with structured context fields
  (`logger.debug({ path, hash }, "...")`), never bare string interpolation. Logs go to stderr only.
  `--json` command output is a completely separate channel (stdout) and must never be mixed with logs.
- **`--json` on every command**, consistent output/error shape, non-zero exit code on any failure.
  Human-readable output (the non-`--json` default, with progress bars) is not covered by tests.

## Documentation

Each task in the project plan names specific `docs/cli/*.md` (user-facing command docs) and
`docs/architecture/*.md` (design-decision docs) files it must produce or update before it's done. See
the plan file for the full list per task.
