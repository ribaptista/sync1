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
