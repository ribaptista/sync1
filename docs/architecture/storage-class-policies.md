# Storage-class policies

The successor to the single-target-class model the removed `ensure_storage_class` command used (see
[storage-classes-and-archive-restore.md](storage-classes-and-archive-restore.md) for the parts of that
design — `classifyArchiveStatus`, `decideStorageClassAction`, the colder-is-a-copy/warmer-is-two-phase
mechanics — that carried over unchanged). This doc covers what's new: a rule-based system
(`storage_policy`) for deciding a path's target class, and how that interacts with dedup.

## Why policies, not a one-off glob+class argument

`ensure_storage_class <glob> <class>` required re-typing the same glob/class pair on every invocation,
with nothing durable recording "this part of the tree should live in Glacier." `storage_policy` makes
that a standing, shared rule: `storage_policy create <glob> <class>`, then `converge` (or `status` to
just check) applies every rule in one pass, with no glob/class to remember or re-type.

## Global, shared, versioned — same reasoning as ignore policies

Storage-class policies live in `state.db`'s `storage_policies` table, not `cache.db` — shared across
every machine backing up the same vault, requiring the vault password to create/edit/delete (each is a
real commit via the same generic `mutateStateDb` helper `ignore` policies also use) but no password to
list. See [ignore-and-storage-policies.md](ignore-and-storage-policies.md) for the shared rationale:
every machine running `converge` has to agree on the same rules, or two machines could make conflicting
archive decisions on the same shared object.

## The default policy and priority ordering

Every vault always has exactly one **default policy** — seeded by the schema migration itself
(`STANDARD`, no glob, no priority), never created or deleted through `storage_policy`. It's the
catch-all for any path no other policy's glob matches, and it's structurally outside the priority
ordering: always the last resort, never competing with a non-default policy for precedence. Only its
`target_class` can ever be edited.

Non-default policies each carry an explicit `priority` (lower checked first) to resolve overlapping
globs — deliberately **not** "most specific glob wins" and **not** "first-created wins." A path's target
class is the first matching policy in priority order, or the default if nothing matches
(`evaluatePathTargetClass`, `src/s3/policy-evaluation.ts`).

## Dedup: warmest wins

One S3 object (a content hash) can be referenced by several paths, and policies match on path — so two
paths sharing a hash can imply _different_ target classes for the same underlying object. This is
resolved as **warmest class wins, with a warning**: `resolveHashTargetClass` evaluates every path
referencing a hash independently, then reduces to the warmest (lowest-`COLDNESS_ORDER`) of those targets
— an object is never archived colder than any path that implies it should stay warm — while flagging
`conflicted: true` when the paths actually disagreed, so the disagreement itself is visible rather than
silently resolved one way. `status`/`converge` both surface these as a `conflicts` array alongside their
counts; neither treats a conflict as a failure (it's an inherent, expected consequence of combining
per-path policies with content-addressed dedup, not a bug).

## `status` vs. `converge`

Both share one iteration/evaluation (`convergeStoragePolicies`, `src/sync/converge-storage-policies.ts`),
differing only in whether a decided action (`decideStorageClassAction`) is actually issued to S3 —
`status` never applies (`apply: false`), `converge` always does (`apply: true`). Neither needs a
`--apply` flag the way `ensure_storage_class` did: `status` fully replaces that command's default
count-only mode, and `converge` fully replaces `--apply`.

## `sync` uploads new content directly into its policy's target class

A brand-new upload (`applyLocalChangesToCandidate`, `src/sync/apply-local-changes.ts`) resolves the
dispatching row's own path against the candidate's storage policies (`resolveHashTargetClass`,
`src/s3/policy-evaluation.ts`, the same function `status`/`converge` use) and passes that class straight
to `PutObjectCommand`/`Upload` (`putObjectStream`, `src/s3/client.ts`) — so an object matching a
GLACIER/DEEP_ARCHIVE policy at the moment it's first backed up never spends even a moment in STANDARD,
and never costs the extra copy `converge` would otherwise have to make right after.

This is resolved once, from the one path that actually dispatched the upload — not re-resolved for a
same-batch dedup attach that rides on the same job afterward. If that attaching path's own policy
implies a warmer class, this doesn't retroactively change a class already in flight; `converge`'s own
dedup warmest-wins resolution (above) is still what a shared object's policy disagreement ultimately has
to settle, the same as it would for two paths synced in different runs entirely.

Three cases this deliberately leaves alone, all for the same reason — none of them uploads new bytes
through this path at all, so there is no class decision to make here:

- **A dedup hit against an object the candidate already knows** (`objectsRepo.has(hash)`) keeps
  whatever class that object already has. Re-evaluating it here would race the very mechanism (dedup
  warmest-wins) that exists to resolve a shared object's policy disagreements deliberately, not
  incidentally.
- **A `--verify-remote` adoption** (a prior aborted run's own upload, found already on S3 by the HEAD
  check) keeps the class it was written with. Nothing here re-uploads it, so there's nothing to attach a
  fresh decision to.
- **The mirror** stores ciphertext with no storage class of its own; the concept doesn't apply to a
  local filesystem copy.

`converge` remains the authority for every one of these, and for a policy edited after the fact — this
is purely an optimization for the _first_ time a policy exists and a matching file is uploaded, not a
replacement for the reconciliation pass.
