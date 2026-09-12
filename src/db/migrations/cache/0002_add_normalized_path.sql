-- Append-only: never edit this file after it has been merged. Add a new
-- numbered migration instead, even for a one-line change.

-- Lowercased `path`, kept in sync by CacheEntriesRepository.upsert() going
-- forward -- lets a case-insensitive collision check use a real index
-- instead of `COLLATE NOCASE` (which can't use path's default BINARY-
-- collation index, forcing a full scan). See
-- docs/architecture/cross-platform-filesystem.md.
ALTER TABLE entries ADD COLUMN normalized_path TEXT NOT NULL DEFAULT '';
UPDATE entries SET normalized_path = LOWER(path);
CREATE INDEX idx_cache_normalized_path ON entries (normalized_path);
