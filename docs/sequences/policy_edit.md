# `sync1 ignore|storage_policy|thumbnail_policy create|edit|delete`

**Derived from:** `src/commands/ignore.ts`, `src/commands/storage_policy.ts`,
`src/commands/thumbnail_policy.ts`, `src/sync/mutate-state-db.ts`

All three policy groups' `create`/`edit`/`delete` subcommands funnel through one shared function,
`mutateStateDb` — a small, self-contained `state.db`-only edit (insert/update/delete a policy row), with
no filesystem walk, no S3 object upload, no local file to materialize. Each group's own `mutate`
callback is the only thing that differs: `(db) => new XPoliciesRepository(db).create(...)`, and
similarly for `update`/`delete`. Needs the password (see
[`flow-unlock-vault.md`](flow-unlock-vault.md)) — every mutation still produces a new encrypted
`state.db` snapshot, exactly like a `sync` commit. Every subcommand runs after the ordinary
lock/root-resolution preamble (see [`flow-preamble.md`](flow-preamble.md)), omitted below since it never
varies.

## Sequence

```mermaid
sequenceDiagram
    participant CLI as ignore/storage_policy/thumbnail_policy create|edit|delete
    participant Cas as flow-cas-commit (Shape 3)
    participant Candidate as candidate.db (temp)
    participant Mirror as flow-mirror-metadata

    CLI->>CLI: setupMutationContext -- getPassword, unlockVault, createS3Client
    CLI->>Cas: mutateStateDb(root, masterKey, s3, mutate) -- enters the 5-attempt CAS loop,<br/>identical structure to gc's -- see flow-cas-commit.md
    Cas->>Candidate: openStateDb(decrypted /current snapshot)
    Candidate->>Candidate: mutate(candidateDb) -- e.g. IgnorePoliciesRepository(db).create(glob)
    alt mutate throws (e.g. "no policy with id N")
        Candidate-->>CLI: propagates immediately -- no CAS attempted, no version minted
    else mutate succeeds
        Candidate->>Candidate: new version stamp; VersionsRepository.insert; wal_checkpoint(TRUNCATE); close
        Candidate->>Cas: PUT states/<newVersionStamp> (plain, unconditional)
        Cas->>Cas: CAS PUT /current, IfMatch: current.etag -- retry-on-conflict loop, see flow-cas-commit.md
        alt CAS succeeds
            Cas->>Mirror: mirrorPathFor(root) -- resolved fresh here, swallow-on-error<br/>(see flow-mirror-metadata.md's note on this vs. sync's own resolution)
            Mirror->>Mirror: mirrorStateSnapshot + mirrorCurrentPointer (best-effort, never fails the commit)
            Cas->>Candidate: copyFileAtomic(candidatePath, state.db); write last_synced_version
            Cas-->>CLI: { versionStamp, result } -- result is whatever `mutate` returned (e.g. new policy id)
        end
    end
```

## Output

```json
{ "ok": true, "id": 4, "glob": "*.tmp", "version_stamp": "2026...-abcd1234" }
```

`create` echoes the new row's id; `edit`/`delete` echo only the new `version_stamp`. Any thrown error
(an unknown id, a malformed glob, a CAS retry exhaustion) fails the command via `exitCodeForError`.

## Notes

- **Concurrency:** none — this is a small, synchronous SQL mutation wrapped in the same CAS-retry
  structure `gc` uses (see [`flow-cas-commit.md`](flow-cas-commit.md), Shape 3). No pool, no filesystem
  walk.
- **The `mutate` callback must be idempotent and self-contained**, since a losing CAS race means the
  _entire_ attempt — including `mutate` itself — reruns from scratch against a freshly re-fetched
  `/current`, up to 5 times. "Insert this specific row" or "delete policy id N" both satisfy this
  naturally; a callback that depended on prior in-memory state across attempts would not.
- **A `mutate` failure (e.g. editing/deleting a nonexistent id) never reaches the CAS at all** — it
  throws synchronously inside the candidate's own transaction, before a new version stamp is even
  minted, so no version is wasted on a rejected edit.
- **Why `list` gets no diagram at all:** it's a single read-only `SELECT` against the already-local,
  already-decrypted `state.db` (opened read-only) — no password, no mutation, no version. See the
  Flow paragraph on each policy group's own `docs/cli/*.md` `list` section instead.
- **On failure:** see [`flow-cas-commit.md`](flow-cas-commit.md)'s own notes — every candidate temp file
  is disposed of on every iteration (success or CAS-conflict retry alike), and exhausting all 5 attempts
  throws a plain `Error`. The mirror write after a successful commit is best-effort and never turns a
  successful policy edit into a reported failure (see
  [`flow-mirror-metadata.md`](flow-mirror-metadata.md)).
- **Sub-flows:** [`flow-cas-commit.md`](flow-cas-commit.md) (Shape 3), [`flow-mirror-metadata.md`](flow-mirror-metadata.md).
