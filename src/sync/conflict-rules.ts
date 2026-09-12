import type { CacheEntryRow } from "../db/repositories/cache-entries-repository.js";
import type { EntryRow } from "../db/repositories/entries-repository.js";

/**
 * Pure decision logic for folding one locally-dirty cache row into state.db,
 * given whatever entry (if any) currently exists there. No I/O, no
 * mutation -- just the create/modified/deleted matrix from the design, so
 * it can be exhaustively unit-tested against every branch. See
 * docs/architecture/conflict-resolution.md for the full writeup of *why*
 * each branch is what it is.
 */
export type LocalChangeDecision =
  { kind: "apply" } | { kind: "noop" } | { kind: "conflict"; reason: string };

function decideCreated(
  row: CacheEntryRow,
  existingEntry: EntryRow | undefined,
): LocalChangeDecision {
  if (!existingEntry) {
    // Deletions are full row removals (no tombstones), so "missing entry"
    // covers both "never existed" and "existed, then was deleted remotely"
    // -- either way, a fresh local creation here isn't a conflict.
    return { kind: "apply" };
  }
  if (existingEntry.hash === row.hash) {
    // Same content already recorded remotely (e.g. two machines independently
    // created identical content, or this is a crash-recovery replay of a
    // create this same machine already committed) -- recoverable, no-op.
    return { kind: "noop" };
  }
  return {
    kind: "conflict",
    reason: `"${row.path}" was created locally, but a different file already exists remotely at this path`,
  };
}

function decideModified(
  row: CacheEntryRow,
  existingEntry: EntryRow | undefined,
): LocalChangeDecision {
  if (!existingEntry) {
    // Can't have been "modified" from nothing -- remote deleted the path
    // this machine was editing. Genuine conflict, needs a human.
    return {
      kind: "conflict",
      reason: `"${row.path}" was modified locally, but it was deleted remotely`,
    };
  }
  if (existingEntry.state_version === row.parent_state_version) {
    // Fast-forward case: nothing has changed remotely since this machine's
    // local baseline for this path.
    return { kind: "apply" };
  }
  if (existingEntry.hash === row.hash) {
    // Remote moved on (state_version differs) but happened to end up with
    // the exact same content this machine independently arrived at --
    // recoverable, no-op. This same leniency is also what makes a
    // half-finished local cache cleanup after a crash self-heal (see
    // docs/architecture/conflict-resolution.md).
    return { kind: "noop" };
  }
  return {
    kind: "conflict",
    reason: `"${row.path}" was modified both locally and remotely with different content`,
  };
}

function decideDeleted(
  row: CacheEntryRow,
  existingEntry: EntryRow | undefined,
): LocalChangeDecision {
  if (!existingEntry) {
    // Both sides already agree it's gone -- nothing to do. This is also
    // what makes a half-finished local cache cleanup after a crash
    // self-heal for the deleted case.
    return { kind: "noop" };
  }
  if (existingEntry.state_version === row.parent_state_version) {
    return { kind: "apply" };
  }
  return {
    kind: "conflict",
    reason: `"${row.path}" was deleted locally, but modified remotely`,
  };
}

export function decideLocalChange(
  row: CacheEntryRow,
  existingEntry: EntryRow | undefined,
): LocalChangeDecision {
  switch (row.state) {
    case "created":
      return decideCreated(row, existingEntry);
    case "modified":
      return decideModified(row, existingEntry);
    case "deleted":
      return decideDeleted(row, existingEntry);
    case "unchanged":
      // performSync only ever calls this for dirty rows; guard defensively
      // rather than silently mis-handling a caller bug.
      throw new Error(`decideLocalChange called with an 'unchanged' row for "${row.path}"`);
  }
}
