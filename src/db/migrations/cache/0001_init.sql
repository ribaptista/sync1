-- Append-only: never edit this file after it has been merged. Add a new
-- numbered migration instead, even for a one-line change.

CREATE TABLE entries (
  path TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('file', 'dir')),
  mtime INTEGER,
  hash TEXT,
  state TEXT NOT NULL CHECK (state IN ('created', 'modified', 'deleted', 'unchanged')),
  parent_state_version TEXT
);

CREATE INDEX idx_cache_state ON entries (state) WHERE state != 'unchanged';
