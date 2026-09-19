-- Append-only: never edit this file after it has been merged. Add a new
-- numbered migration instead, even for a one-line change.
--
-- Exception, deliberate and one-time: this table's very first shape (the
-- CREATE TABLE below) is being edited in place rather than layered under a
-- new migration, because no production vault has ever had a configured
-- thumbnail policy (confirmed empty) -- the append-only rule exists to
-- protect a vault that already applied a migration against real deployed
-- data, and there is no real deployed data here yet to protect. Building
-- the rebuild/AUTOINCREMENT-carryover/MIN()-derivation machinery a real
-- migration would need, purely to reshape a table nothing has ever
-- written a row into, would be process for its own sake. The append-only
-- rule stays in force for every migration from this point on, including
-- any future change to this same table.

-- Global (shared, versioned) thumbnail-generation policies: a GLOB pattern
-- (evaluated in memory, with real ** support -- see src/fs/glob-match.ts)
-- paired with a mime-type filter and either a 'skip' or 'generate'
-- disposition. Like ignore_policies, any matching 'skip' wins outright
-- (monotonic OR, no priority needed among skips). Unlike storage_policies,
-- there is NO mandatory default row -- a file matching nothing is simply
-- not a thumbnail candidate. `priority` only breaks ties among multiple
-- matching 'generate' rows; always NULL for 'skip' rows.
CREATE TABLE thumbnail_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  glob TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('skip', 'generate')),
  priority INTEGER,
  -- JSON-encoded array of mime-type patterns, e.g. ["image/jpeg","video/*"].
  -- The subtype segment may be a literal "*" wildcard; the type segment
  -- never is (this is not a general glob). Parsed/serialized at the
  -- repository boundary, never queried through SQL.
  mime_types TEXT NOT NULL,
  -- 'image' or 'video', NULL for a 'skip' row -- which generate-field
  -- subset below actually applies to a 'generate' row. A policy is
  -- explicitly an image policy or a video policy: no more nonsense tile
  -- fields on an image-only policy, no more nonsense image fields on a
  -- video-only one.
  media_type TEXT CHECK (media_type IS NULL OR media_type IN ('image', 'video')),
  image_width INTEGER CHECK (image_width IS NULL OR image_width > 0),
  image_height INTEGER CHECK (image_height IS NULL OR image_height > 0),
  tile_row_count INTEGER CHECK (tile_row_count IS NULL OR tile_row_count > 0),
  tile_column_count INTEGER CHECK (tile_column_count IS NULL OR tile_column_count > 0),
  -- Shorter-side target in pixels for one mosaic tile -- the longer side
  -- is derived per source video from its own aspect ratio, never
  -- configured directly. Replaces the old fixed tile_width/tile_height
  -- box: every frame sampled from one video shares that video's aspect
  -- ratio, so every cell in one mosaic run is automatically
  -- pixel-identical with no separate box to letterbox into.
  tile_size INTEGER CHECK (tile_size IS NULL OR tile_size > 0),
  jpeg_quality INTEGER CHECK (jpeg_quality IS NULL OR (jpeg_quality BETWEEN 1 AND 100)),
  created_at TEXT NOT NULL,
  CHECK (
    (action = 'skip' AND media_type IS NULL
      AND image_width IS NULL AND image_height IS NULL
      AND tile_row_count IS NULL AND tile_column_count IS NULL
      AND tile_size IS NULL AND jpeg_quality IS NULL)
    OR
    (action = 'generate' AND media_type = 'image'
      AND image_width IS NOT NULL AND image_height IS NOT NULL
      AND tile_row_count IS NULL AND tile_column_count IS NULL AND tile_size IS NULL
      AND jpeg_quality IS NOT NULL)
    OR
    (action = 'generate' AND media_type = 'video'
      AND image_width IS NULL AND image_height IS NULL
      AND tile_row_count IS NOT NULL AND tile_column_count IS NOT NULL AND tile_size IS NOT NULL
      AND jpeg_quality IS NOT NULL)
  )
);
