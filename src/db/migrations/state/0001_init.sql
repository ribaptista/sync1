-- Append-only: never edit this file after it has been merged. Add a new
-- numbered migration instead, even for a one-line change.

CREATE TABLE versions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  version_stamp TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE objects (
  hash TEXT PRIMARY KEY,
  s3_key TEXT NOT NULL,
  size INTEGER NOT NULL
);

CREATE TABLE entries (
  path TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('file', 'dir')),
  hash TEXT REFERENCES objects (hash),
  state_version TEXT NOT NULL REFERENCES versions (version_stamp)
);

CREATE INDEX idx_entries_hash ON entries (hash);
CREATE INDEX idx_entries_state_version ON entries (state_version);
