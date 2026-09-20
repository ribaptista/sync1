-- Rebuild (create-copy-drop-rename), per the append-only rule that's been
-- back in force since 0005's own one-time exception. No production vault
-- has ever had a configured thumbnail policy, so this never actually
-- migrates real rows -- but it's still written as a real reshape, not an
-- in-place edit, because the exception was for 0005's original shape only.
--
-- Two changes: policies are now named (a UNIQUE, non-empty,
-- alphanumeric-plus-underscore identifier -- see src/fs/thumbnail.ts's
-- filename-grammar use of it), and `priority` is gone. Every matching
-- 'generate' policy now produces its own thumbnail rather than one policy
-- winning by priority -- `skip` stays a veto (see docs/architecture/
-- thumbnails.md).
CREATE TABLE thumbnail_policies_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE CHECK (length(name) > 0 AND name NOT GLOB '*[^A-Za-z0-9_]*'),
  glob TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('skip', 'generate')),
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
  -- configured directly.
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

-- Never exercised against real data (see above) -- a synthetic name keeps
-- this a genuine, correct copy rather than one that only works on an
-- empty table.
INSERT INTO thumbnail_policies_new (
  id, name, glob, action, mime_types, media_type, image_width, image_height,
  tile_row_count, tile_column_count, tile_size, jpeg_quality, created_at
)
SELECT
  id, 'policy_' || id, glob, action, mime_types, media_type, image_width, image_height,
  tile_row_count, tile_column_count, tile_size, jpeg_quality, created_at
FROM thumbnail_policies;

DROP TABLE thumbnail_policies;
ALTER TABLE thumbnail_policies_new RENAME TO thumbnail_policies;
