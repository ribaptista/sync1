# Sequence diagrams

Deep, code-accurate sequence diagrams for the sync1 command surface — what actually happens, in what
order, and what runs concurrently with what. Complements `docs/cli/*.md` (what each flag does) and
`docs/architecture/*.md` (why the design is what it is); neither answers the questions these diagrams do.

Two kinds of file:

- **Command files** — one per command (or tightly related group), tracing that command's own
  top-level flow. Each links out to the flow files it composes rather than inlining them.
- **Flow files** (prefixed `flow-`) — self-contained, reusable sub-logic shared across multiple
  commands: a paragraph explaining what it does and why, a diagram, and a `Used by:` backlink list.

Every file names its `Derived from:` source files at the top — strictly what the code does, nothing
inferred or idealized. See the convention note in [AGENTS.md](../../AGENTS.md) for how these are kept
from rotting silently.

## Command files

| File                                     | Covers                                                                |
| ---------------------------------------- | --------------------------------------------------------------------- |
| [sync.md](sync.md)                       | `performSync`'s three phases (scan/upload/download) and the commit    |
| [update_cache.md](update_cache.md)       | The filesystem/cache.db merge-join; also sync's own scanning phase    |
| [materialize.md](materialize.md)         | Nested s3-pool → stream-pool dispatch; the archive/restore ladder     |
| [stubify.md](stubify.md)                 | The commit precondition ladder, rehash dispatch, the mirror gate      |
| [gc.md](gc.md)                           | The CAS loop, and "commit metadata, then delete bytes"                |
| [thumbnail.md](thumbnail.md)             | `scanThumbnails`'s three modes over one scan; three walks             |
| [converge_status.md](converge_status.md) | `status`/`converge`'s shared evaluation and action matrix             |
| [sanity_check.md](sanity_check.md)       | One read producing both hash and checksum; the stream-then-S3 drain   |
| [mirror.md](mirror.md)                   | `verify`/`catchup`/`prune`, including catchup's local-recovery ladder |
| [policy_edit.md](policy_edit.md)         | The create/edit/delete path shared by all three policy groups         |
| [init_attach.md](init_attach.md)         | Vault creation vs. joining; the first-write-wins CAS variant          |

## Flow files

| File                                                         | What it encapsulates                                                                                                        | Used by                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [flow-preamble.md](flow-preamble.md)                         | Lock/root-resolution hook, stale temp sweep, the `init_remote`/`attach_remote` exemption                                    | all except init_attach.md                                |
| [flow-unlock-vault.md](flow-unlock-vault.md)                 | `remote.json` → password → `unlockVault` (Argon2id)                                                                         | sync, gc, materialize, mirror, policy_edit, sanity_check |
| [flow-pool-dispatch.md](flow-pool-dispatch.md)               | The `waitForRoom`/`dispatchTracked`/`onIdle`/`throwIfPoolErrored` idiom, plus the `BoundedTaskTracker` variant              | all concurrent flows                                     |
| [flow-enumeration-pass.md](flow-enumeration-pass.md)         | The second, never-awaited, error-swallowing concurrent walk four commands run for a progress denominator                    | update_cache, stubify, sanity_check, thumbnail           |
| [flow-s3-retry.md](flow-s3-retry.md)                         | `withS3Retry`'s unbounded backoff — and which commands deliberately skip it                                                 | sync, materialize                                        |
| [flow-put-object-stream.md](flow-put-object-stream.md)       | The 32 MiB single-PUT-vs-multipart branch and checksum verification                                                         | flow-apply-local-changes                                 |
| [flow-encrypt-stream.md](flow-encrypt-stream.md)             | Chunked AEAD, the `expectedHash` abort seam, and `onPlaintextHash`                                                          | flow-encrypt-file                                        |
| [flow-encrypt-file.md](flow-encrypt-file.md)                 | The shared read-encrypt-checksum pipeline sync, mirror, and sanity_check each used to assemble separately                   | flow-apply-local-changes, mirror, sanity_check           |
| [flow-cas-commit.md](flow-cas-commit.md)                     | Three CAS shapes side by side: sync's read-back reconciliation, gc's and policy_edit's 5-attempt recompute loops            | sync, gc, policy_edit                                    |
| [flow-candidate-db.md](flow-candidate-db.md)                 | Sync's candidate temp state.db: born, fetched, applied, committed, cleaned up                                               | sync, gc                                                 |
| [flow-mirror-metadata.md](flow-mirror-metadata.md)           | The three small mirrored keys, and sync's eager/fail-fast vs. gc/policy_edit's lazy/swallow-on-error mirror-path resolution | sync, gc, policy_edit                                    |
| [flow-atomic-publish.md](flow-atomic-publish.md)             | The generic temp-sibling → rename idiom, and the `renameWithRetry`/bare-`renameSync` split                                  | materialize, thumbnail, mirror, stubify                  |
| [flow-archive-status.md](flow-archive-status.md)             | `classifyArchiveStatus`'s four states and the restore dance                                                                 | materialize, converge_status, mirror                     |
| [flow-apply-local-changes.md](flow-apply-local-changes.md)   | Sync's upload phase: the decision ladder, claim-before-dispatch, the concurrent verifyRemote HEAD checks, the tee           | sync                                                     |
| [flow-apply-remote-changes.md](flow-apply-remote-changes.md) | Sync's download phase: the merge-join, the stub-vs-download branch                                                          | sync                                                     |

## Not diagrammed — prose only

`diff`, `inspect`, `fetch_remote`, and each policy group's `list` subcommand are simple enough (one
paginated query, one lookup, three plain calls) that a diagram wouldn't earn its place. Each has a short
**Flow** paragraph instead, in its own `docs/cli/*.md` file.
