-- Append-only: never edit this file after it has been merged. Add a new
-- numbered migration instead, even for a one-line change.

-- File size in bytes, from the same stat() call the walker already makes
-- for mtime -- previously computed and silently discarded on every scan.
-- NULL only for a directory row or a tombstone ('deleted'), exactly
-- mirroring hash/mtime's existing nullability for those same two cases.
-- The CHECK is a real, DB-enforced invariant, not just convention: it's
-- accepted here only because entries is empty at migration time (SQLite
-- evaluates a new column's CHECK against every existing row immediately),
-- and from this point on it's enforced on every write -- an INSERT/UPDATE
-- that would leave a live (non-deleted) file row's size NULL is rejected
-- by SQLite itself. No backfill: unlike normalized_path's free LOWER(path)
-- derivation, a size backfill would mean a real fs.statSync() per already-
-- tracked row during the migration itself, which doesn't belong there.
ALTER TABLE entries ADD COLUMN size INTEGER
  CHECK (type != 'file' OR state = 'deleted' OR size IS NOT NULL);
