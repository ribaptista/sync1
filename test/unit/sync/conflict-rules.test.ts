import { describe, it, expect } from "vitest";
import { decideLocalChange } from "../../../src/sync/conflict-rules.js";
import type { CacheEntryRow } from "../../../src/db/repositories/cache-entries-repository.js";
import type { EntryRow } from "../../../src/db/repositories/entries-repository.js";

function cacheRow(overrides: Partial<CacheEntryRow>): CacheEntryRow {
  return {
    path: "a.txt",
    type: "file",
    mtime: 1000,
    hash: "hash-local",
    size: 10,
    state: "created",
    parent_state_version: "v0",
    ...overrides,
  };
}

function entryRow(overrides: Partial<EntryRow>): EntryRow {
  return {
    path: "a.txt",
    type: "file",
    hash: "hash-remote",
    state_version: "v0",
    ...overrides,
  };
}

describe("decideLocalChange: created", () => {
  it("applies when no entry exists remotely (never existed)", () => {
    const decision = decideLocalChange(cacheRow({ state: "created" }), undefined);
    expect(decision).toEqual({ kind: "apply" });
  });

  it("applies when no entry exists remotely (path was deleted remotely -- no tombstone)", () => {
    // Deletions are full row removals, so this is indistinguishable from
    // "never existed" from state.db's point of view, which is exactly the
    // point: no special-casing needed.
    const decision = decideLocalChange(cacheRow({ state: "created" }), undefined);
    expect(decision).toEqual({ kind: "apply" });
  });

  it("no-ops when an entry already exists with the same hash", () => {
    const decision = decideLocalChange(
      cacheRow({ state: "created", hash: "same-hash" }),
      entryRow({ hash: "same-hash" }),
    );
    expect(decision).toEqual({ kind: "noop" });
  });

  it("conflicts when a different entry already exists with a different hash", () => {
    const decision = decideLocalChange(
      cacheRow({ state: "created", hash: "hash-A" }),
      entryRow({ hash: "hash-B" }),
    );
    expect(decision.kind).toBe("conflict");
  });
});

describe("decideLocalChange: modified", () => {
  it("conflicts when the entry no longer exists remotely (deleted elsewhere)", () => {
    const decision = decideLocalChange(cacheRow({ state: "modified" }), undefined);
    expect(decision.kind).toBe("conflict");
  });

  it("applies (fast-forward) when remote state_version matches the local baseline", () => {
    const decision = decideLocalChange(
      cacheRow({ state: "modified", parent_state_version: "v1" }),
      entryRow({ state_version: "v1" }),
    );
    expect(decision).toEqual({ kind: "apply" });
  });

  it("no-ops when remote moved on but ended up with the same hash", () => {
    const decision = decideLocalChange(
      cacheRow({ state: "modified", parent_state_version: "v1", hash: "same-hash" }),
      entryRow({ state_version: "v2", hash: "same-hash" }),
    );
    expect(decision).toEqual({ kind: "noop" });
  });

  it("conflicts when remote moved on with a different hash", () => {
    const decision = decideLocalChange(
      cacheRow({ state: "modified", parent_state_version: "v1", hash: "hash-A" }),
      entryRow({ state_version: "v2", hash: "hash-B" }),
    );
    expect(decision.kind).toBe("conflict");
  });
});

describe("decideLocalChange: deleted", () => {
  it("no-ops when the entry is already gone remotely (both sides agree)", () => {
    const decision = decideLocalChange(cacheRow({ state: "deleted", hash: null }), undefined);
    expect(decision).toEqual({ kind: "noop" });
  });

  it("applies when remote state_version matches the local baseline", () => {
    const decision = decideLocalChange(
      cacheRow({ state: "deleted", hash: null, parent_state_version: "v1" }),
      entryRow({ state_version: "v1" }),
    );
    expect(decision).toEqual({ kind: "apply" });
  });

  it("conflicts when remote modified the path after the local baseline", () => {
    const decision = decideLocalChange(
      cacheRow({ state: "deleted", hash: null, parent_state_version: "v1" }),
      entryRow({ state_version: "v2" }),
    );
    expect(decision.kind).toBe("conflict");
  });
});

describe("decideLocalChange: crash-recovery self-healing", () => {
  // These mirror the exact scenario from the design conversation: a sync
  // committed successfully but crashed before cache.db cleanup ran, so on
  // the next attempt the (still-dirty) cache row is compared against a
  // state.db that already reflects this same machine's own prior commit.
  it("self-heals a half-finished 'created' cleanup (same hash now committed)", () => {
    const decision = decideLocalChange(
      cacheRow({ state: "created", hash: "X", parent_state_version: "v0" }),
      entryRow({ hash: "X", state_version: "v1" }), // this machine's own prior commit
    );
    expect(decision).toEqual({ kind: "noop" });
  });

  it("self-heals a half-finished 'modified' cleanup (same hash now committed)", () => {
    const decision = decideLocalChange(
      cacheRow({ state: "modified", hash: "X", parent_state_version: "v0" }),
      entryRow({ hash: "X", state_version: "v1" }),
    );
    expect(decision).toEqual({ kind: "noop" });
  });

  it("self-heals a half-finished 'deleted' cleanup (entry already gone)", () => {
    const decision = decideLocalChange(
      cacheRow({ state: "deleted", hash: null, parent_state_version: "v0" }),
      undefined, // this machine's own prior commit already removed it
    );
    expect(decision).toEqual({ kind: "noop" });
  });
});

describe("decideLocalChange: guards", () => {
  it("throws if called with an 'unchanged' row", () => {
    expect(() => decideLocalChange(cacheRow({ state: "unchanged" }), undefined)).toThrow(
      /unchanged/,
    );
  });
});
