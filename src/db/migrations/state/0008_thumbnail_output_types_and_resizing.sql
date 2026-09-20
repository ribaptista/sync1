-- Rebuild (create-copy-drop-rename), same rationale as 0007. No production
-- vault has ever had a configured thumbnail policy, so this never actually
-- migrates real rows -- but it's still written as a real reshape.
--
-- Two independent new dimensions:
--
-- - An image policy now picks a `resizing_strategy`: 'fit_to_box' (the
--   existing image_width/image_height behavior, unchanged) or
--   'resize_shorter_side' (a new `shorter_side` column -- scale so the
--   source's own shorter side lands on this value, long side falls out of
--   its aspect ratio, exactly like a video mosaic tile's own `tile_size`).
-- - A video policy now picks an `output_type`: 'mosaic' (the existing
--   tile_row_count/tile_column_count/tile_size behavior, unchanged) or
--   'gif' (a new `frame_count`/`frame_delay_ms` pair; `tile_size` is
--   reused, not duplicated, as the GIF's own per-frame shorter-side
--   target -- see docs/architecture/thumbnails.md for why the column/flag
--   name stays `tile_size` rather than gaining a GIF-specific synonym).
--
-- jpeg_quality is NOT required for a 'gif' row -- a GIF is never JPEG, so
-- requiring (and silently ignoring) a JPEG quality for it would violate
-- this table's own established "no nonsense fields for a branch that
-- doesn't use them" discipline (see the three-way CHECK this table
-- already had before this migration).
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
  -- subset below actually applies to a 'generate' row.
  media_type TEXT CHECK (media_type IS NULL OR media_type IN ('image', 'video')),
  -- 'image' rows only: which of the two fields below is populated.
  resizing_strategy TEXT CHECK (resizing_strategy IS NULL OR resizing_strategy IN ('fit_to_box', 'resize_shorter_side')),
  image_width INTEGER CHECK (image_width IS NULL OR image_width > 0),
  image_height INTEGER CHECK (image_height IS NULL OR image_height > 0),
  shorter_side INTEGER CHECK (shorter_side IS NULL OR shorter_side > 0),
  -- 'video' rows only: which of the two field groups below is populated.
  output_type TEXT CHECK (output_type IS NULL OR output_type IN ('mosaic', 'gif')),
  tile_row_count INTEGER CHECK (tile_row_count IS NULL OR tile_row_count > 0),
  tile_column_count INTEGER CHECK (tile_column_count IS NULL OR tile_column_count > 0),
  -- Shared by 'mosaic' (one tile's shorter side) and 'gif' (one frame's
  -- shorter side) -- see the header comment above.
  tile_size INTEGER CHECK (tile_size IS NULL OR tile_size > 0),
  frame_count INTEGER CHECK (frame_count IS NULL OR frame_count > 0),
  frame_delay_ms INTEGER CHECK (frame_delay_ms IS NULL OR frame_delay_ms > 0),
  jpeg_quality INTEGER CHECK (jpeg_quality IS NULL OR (jpeg_quality BETWEEN 1 AND 100)),
  created_at TEXT NOT NULL,
  CHECK (
    (action = 'skip' AND media_type IS NULL
      AND resizing_strategy IS NULL AND output_type IS NULL
      AND image_width IS NULL AND image_height IS NULL AND shorter_side IS NULL
      AND tile_row_count IS NULL AND tile_column_count IS NULL AND tile_size IS NULL
      AND frame_count IS NULL AND frame_delay_ms IS NULL
      AND jpeg_quality IS NULL)
    OR
    (action = 'generate' AND media_type = 'image' AND resizing_strategy = 'fit_to_box'
      AND output_type IS NULL
      AND image_width IS NOT NULL AND image_height IS NOT NULL AND shorter_side IS NULL
      AND tile_row_count IS NULL AND tile_column_count IS NULL AND tile_size IS NULL
      AND frame_count IS NULL AND frame_delay_ms IS NULL
      AND jpeg_quality IS NOT NULL)
    OR
    (action = 'generate' AND media_type = 'image' AND resizing_strategy = 'resize_shorter_side'
      AND output_type IS NULL
      AND image_width IS NULL AND image_height IS NULL AND shorter_side IS NOT NULL
      AND tile_row_count IS NULL AND tile_column_count IS NULL AND tile_size IS NULL
      AND frame_count IS NULL AND frame_delay_ms IS NULL
      AND jpeg_quality IS NOT NULL)
    OR
    (action = 'generate' AND media_type = 'video' AND output_type = 'mosaic'
      AND resizing_strategy IS NULL
      AND image_width IS NULL AND image_height IS NULL AND shorter_side IS NULL
      AND tile_row_count IS NOT NULL AND tile_column_count IS NOT NULL AND tile_size IS NOT NULL
      AND frame_count IS NULL AND frame_delay_ms IS NULL
      AND jpeg_quality IS NOT NULL)
    OR
    (action = 'generate' AND media_type = 'video' AND output_type = 'gif'
      AND resizing_strategy IS NULL
      AND image_width IS NULL AND image_height IS NULL AND shorter_side IS NULL
      AND tile_row_count IS NULL AND tile_column_count IS NULL AND tile_size IS NOT NULL
      AND frame_count IS NOT NULL AND frame_delay_ms IS NOT NULL
      AND jpeg_quality IS NULL)
  )
);

-- Never exercised against real data (see above). Every pre-existing row
-- was a 'generate'+'image' row implicitly using what's now called
-- 'fit_to_box', or a 'generate'+'video' row implicitly using what's now
-- called 'mosaic' -- both map onto the new schema without any field
-- reinterpretation, so the copy is a straight column carry-over plus the
-- two new discriminator values.
INSERT INTO thumbnail_policies_new (
  id, name, glob, action, mime_types, media_type,
  resizing_strategy, image_width, image_height, shorter_side,
  output_type, tile_row_count, tile_column_count, tile_size,
  frame_count, frame_delay_ms, jpeg_quality, created_at
)
SELECT
  id, name, glob, action, mime_types, media_type,
  CASE WHEN media_type = 'image' THEN 'fit_to_box' END,
  image_width, image_height, NULL,
  CASE WHEN media_type = 'video' THEN 'mosaic' END,
  tile_row_count, tile_column_count, tile_size,
  NULL, NULL, jpeg_quality, created_at
FROM thumbnail_policies;

DROP TABLE thumbnail_policies;
ALTER TABLE thumbnail_policies_new RENAME TO thumbnail_policies;
