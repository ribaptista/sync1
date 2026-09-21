-- Append-only audit trail of paths removed from `entries`. Written by the
-- same transaction that removes the row, never read by sync logic -- this
-- exists so "what happened to this file, and when?" is answerable from the
-- vault itself, since `entries` deletions are full row removals rather than
-- tombstones (see docs/architecture/conflict-resolution.md).
--
-- Two things this table does NOT mean, worth stating plainly: a rename
-- (there's no rename primitive anywhere in this system -- update_cache
-- resolves one as an independent delete + create) appears here as a
-- deletion, recoverable only by an audit-time query (a deletion row whose
-- `hash` matches a path created in the same `deleted_in_version`); an
-- overwrite (a path's row replaced via `upsert`, e.g. a file<->dir type
-- change) never passes through `delete` at all, so it leaves no row here --
-- this logs rows removed from `entries`, not every way a path's content
-- stopped being reachable.
CREATE TABLE entry_deletions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('file', 'dir')),
  -- Deliberately NOT `REFERENCES objects (hash)`, unlike `entries.hash`.
  -- An orphaned object is by definition one no `entries` row references --
  -- exactly the hashes recorded here -- so an FK would make `gc --apply`
  -- fail with SQLITE_CONSTRAINT_FOREIGNKEY (state.db is opened with
  -- `foreign_keys = ON`), or, with ON DELETE CASCADE, silently erase the
  -- very rows this table exists to keep. This pointer is expected to dangle
  -- after a gc: it records what the hash *was*. NULL for a 'dir' row.
  hash TEXT,
  -- The commit that last wrote this path, then the commit that removed it.
  -- FKs on both are safe today (nothing anywhere deletes from `versions`)
  -- and catch a bogus version stamp -- unlike `hash` above, there's no
  -- analogous reason to leave these unconstrained.
  introduced_in_version TEXT NOT NULL REFERENCES versions (version_stamp),
  deleted_in_version TEXT NOT NULL REFERENCES versions (version_stamp),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_entry_deletions_path ON entry_deletions (path);
