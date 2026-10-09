-- Append-only: never edit this file after it has been merged. Add a new
-- numbered migration instead, even for a one-line change.
--
-- Makes "a file entry has a hash, a directory entry doesn't" a schema
-- invariant instead of a convention every writer happens to follow and
-- every reader has to defend against.
--
-- `entries.hash` has always been nullable (0001_init.sql), but only
-- because directories carry no content to hash. Every writer already
-- respects the real rule: `apply-local-changes.ts` sets `hash: null` for a
-- directory row and a real `hash` for every file row, and nothing ever
-- wrote the other combination. sanity_check (src/fs/sanity-check.ts) used
-- to defend against a file row with no hash anyway, by falling back to a
-- plain hash-only read that it then never compared against anything --
-- dead code protecting against a state nothing could actually produce.
--
-- Enforcing it here turns "a file row with no hash" from a silently
-- tolerated possibility into a schema violation sanity_check (or any other
-- reader) can now simply assume away, the same way 0011 turned an
-- unverified upload from a tolerated NULL into a hard failure.
--
-- SQLite cannot add a CHECK in place, hence the same create-copy-drop-
-- rename dance 0011 and 0002 use. See the comment on `runMigrations` in
-- src/db/migrations/runner.ts for why foreign keys are disabled for the
-- pass and `foreign_key_check` runs afterwards instead.
--
-- If any existing row already violates the new CHECK, the INSERT below
-- fails and the whole migration rolls back -- intended, since such a row
-- is exactly the kind of state.db corruption sanity_check exists to catch,
-- and silently repairing it here would destroy the evidence instead of
-- surfacing it.

CREATE TABLE entries_new (
  path TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('file', 'dir')),
  hash TEXT REFERENCES objects (hash),
  state_version TEXT NOT NULL REFERENCES versions (version_stamp),
  normalized_path TEXT NOT NULL DEFAULT '',
  CHECK ((type = 'file') = (hash IS NOT NULL))
);

INSERT INTO entries_new (path, type, hash, state_version, normalized_path)
  SELECT path, type, hash, state_version, normalized_path FROM entries;

DROP TABLE entries;

ALTER TABLE entries_new RENAME TO entries;

CREATE INDEX idx_entries_hash ON entries (hash);
CREATE INDEX idx_entries_state_version ON entries (state_version);
CREATE INDEX idx_entries_normalized_path ON entries (normalized_path);
