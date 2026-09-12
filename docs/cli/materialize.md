# `sync1 materialize`

Downloads and materializes stub files matching a glob pattern — the counterpart to `stubify`, and how
you get real content back after a stub-only restore (`attach_remote` + `sync`).

## Usage

```bash
sync1 materialize <glob> --root <local-path> [--request-retrieval] [--json] [--verbose]
```

## Arguments and options

| Argument/Flag         | Required | Description                                                                                                                                                           |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<glob>`              | yes      | SQLite `GLOB` pattern matched against tracked paths (e.g. `photos/2024/*`).                                                                                           |
| `--root <path>`       | yes      | Local directory to operate on.                                                                                                                                        |
| `--request-retrieval` | no       | Request a temporary S3 restore for matched content that's currently archived (`GLACIER`/`DEEP_ARCHIVE`). Without it, archived content is just counted, not requested. |

The vault password is required (materializing decrypts content).

## What it does

For each matched path currently backed by a stub:

1. Checks the underlying object's archive status.
2. If it's immediately readable (or a prior restore has completed): downloads it, decrypts it,
   verifies the result's hash matches what the stub declared, writes it to a temp file, renames that
   into place, and **only then** deletes the stub — an interrupted `materialize` always leaves you with
   the real file already correct and, at worst, a leftover stub that the next `update_cache`/`sync`
   cleans up automatically.
3. If it's archived and no restore has been requested yet (or a previous one expired): reports it as
   needing retrieval, or actually requests one if `--request-retrieval` is passed.
4. If a restore is already in progress: reports it as pending.

Paths that are already real (not currently stubbed) are simply counted as such, not treated as errors.

## Output

```json
{
  "ok": true,
  "materialized": 3,
  "already_real": 1,
  "needs_retrieval": 0,
  "retrieval_requested": 0,
  "pending": 0
}
```

## Exit codes

- `0` — success (regardless of how many matched paths needed retrieval rather than materializing).
- `1` — wrong password, a stub references unknown/missing content (corrupt vault), or an S3/network
  error.

## Example

```bash
# see what's stubbed under photos/2024
SYNC1_PASSWORD='correct horse battery staple' sync1 materialize "photos/2024/*" --root ~/Pictures --json

# bring back an archived file, requesting its temporary restore
sync1 materialize "photos/2024/vacation.mov" --root ~/Pictures --request-retrieval --json
```
