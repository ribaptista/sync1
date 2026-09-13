-- Append-only: never edit this file after it has been merged. Add a new
-- numbered migration instead, even for a one-line change.

-- Global (shared, versioned) thumbnail-generation policies: a GLOB pattern
-- (evaluated in memory, with real ** support -- see src/fs/glob-match.ts)
-- paired with a mime-type filter and either a 'skip' or 'generate'
-- disposition. Like ignore_policies, any matching 'skip' wins outright
-- (monotonic OR, no priority needed among skips). Unlike storage_policies,
-- there is NO mandatory default row -- a file matching nothing is simply
-- not a thumbnail candidate. `priority` only breaks ties among multiple
-- matching 'generate' rows; always NULL for 'skip' rows. The six
-- generate-only columns are NULL for 'skip' rows, NOT NULL for 'generate'.
CREATE TABLE thumbnail_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  glob TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('skip', 'generate')),
  priority INTEGER,
  -- JSON-encoded array of mime-type patterns, e.g. ["image/jpeg","video/*"].
  -- The subtype segment may be a literal "*" wildcard; nothing else here is
  -- a wildcard (this is not a general glob). Parsed/serialized at the
  -- repository boundary, never queried through SQL.
  mime_types TEXT NOT NULL,
  image_width INTEGER CHECK (image_width IS NULL OR image_width > 0),
  image_height INTEGER CHECK (image_height IS NULL OR image_height > 0),
  tile_row_count INTEGER CHECK (tile_row_count IS NULL OR tile_row_count > 0),
  tile_column_count INTEGER CHECK (tile_column_count IS NULL OR tile_column_count > 0),
  tile_width INTEGER CHECK (tile_width IS NULL OR tile_width > 0),
  tile_height INTEGER CHECK (tile_height IS NULL OR tile_height > 0),
  jpeg_quality INTEGER CHECK (jpeg_quality IS NULL OR (jpeg_quality BETWEEN 1 AND 100)),
  created_at TEXT NOT NULL,
  CHECK (
    (action = 'skip' AND image_width IS NULL AND image_height IS NULL
      AND tile_row_count IS NULL AND tile_column_count IS NULL
      AND tile_width IS NULL AND tile_height IS NULL AND jpeg_quality IS NULL)
    OR
    (action = 'generate' AND image_width IS NOT NULL AND image_height IS NOT NULL
      AND tile_row_count IS NOT NULL AND tile_column_count IS NOT NULL
      AND tile_width IS NOT NULL AND tile_height IS NOT NULL AND jpeg_quality IS NOT NULL)
  )
);
