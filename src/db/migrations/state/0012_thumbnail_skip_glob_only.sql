-- Rebuild (create-copy-drop-rename), same rationale as 0007/0009 -- but,
-- unlike those two, this one *does* migrate real rows: unlike every prior
-- thumbnail_policies reshape, production vaults now have configured skip
-- rows (with a mime_types filter that was always redundant for 'skip').
--
-- A 'skip' row now matches by glob alone -- `mime_types` becomes NULL for
-- it, enforced by a new CHECK tying the two together exactly the way the
-- table's other CHECKs already tie 'skip' to every other NULL generate-only
-- column. This is what lets the scan resolve a skip match straight from
-- its glob, with zero media probing and zero progress-bar bookkeeping,
-- instead of needing a prober result just to confirm what skip's own
-- glob-plus-mime design made nothing but a path decision in the first
-- place. See docs/architecture/thumbnails.md.
CREATE TABLE thumbnail_policies_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE CHECK (length(name) > 0 AND name NOT GLOB '*[^A-Za-z0-9_]*'),
  glob TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('skip', 'generate')),
  -- JSON-encoded array of mime-type patterns, e.g. ["image/jpeg","video/*"]
  -- -- NULL for a 'skip' row (see the CHECK below), required for
  -- 'generate'. The subtype segment may be a literal "*" wildcard; the
  -- type segment never is (this is not a general glob). Parsed/serialized
  -- at the repository boundary, never queried through SQL.
  mime_types TEXT,
  media_type TEXT CHECK (media_type IS NULL OR media_type IN ('image', 'video')),
  resizing_strategy TEXT CHECK (resizing_strategy IS NULL OR resizing_strategy IN ('fit_to_box', 'resize_shorter_side')),
  image_width INTEGER CHECK (image_width IS NULL OR image_width > 0),
  image_height INTEGER CHECK (image_height IS NULL OR image_height > 0),
  shorter_side INTEGER CHECK (shorter_side IS NULL OR shorter_side > 0),
  output_type TEXT CHECK (output_type IS NULL OR output_type IN ('mosaic', 'preview')),
  tile_row_count INTEGER CHECK (tile_row_count IS NULL OR tile_row_count > 0),
  tile_column_count INTEGER CHECK (tile_column_count IS NULL OR tile_column_count > 0),
  frame_count INTEGER CHECK (frame_count IS NULL OR frame_count > 0),
  frame_delay_ms INTEGER CHECK (frame_delay_ms IS NULL OR frame_delay_ms > 0),
  output_mime TEXT CHECK (output_mime IS NULL OR output_mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  jpeg_quality INTEGER CHECK (jpeg_quality IS NULL OR (jpeg_quality BETWEEN 1 AND 100)),
  png_compression_level INTEGER CHECK (png_compression_level IS NULL OR (png_compression_level BETWEEN 0 AND 9)),
  webp_quality INTEGER CHECK (webp_quality IS NULL OR (webp_quality BETWEEN 1 AND 100)),
  webp_lossless INTEGER CHECK (webp_lossless IS NULL OR webp_lossless IN (0, 1)),
  gif_max_colors INTEGER CHECK (gif_max_colors IS NULL OR (gif_max_colors BETWEEN 2 AND 256)),
  gif_dither TEXT CHECK (gif_dither IS NULL OR gif_dither IN
    ('none', 'bayer', 'heckbert', 'floyd_steinberg', 'sierra2', 'sierra2_4a', 'sierra3', 'burkes', 'atkinson')),
  created_at TEXT NOT NULL,
  -- New: a 'skip' row has no mime filter at all; a 'generate' row always
  -- needs one (to know which probed mime types it applies to).
  CHECK ((action = 'skip') = (mime_types IS NULL)),
  -- 1. Sizing columns must match (media_type, resizing_strategy | output_type). Unchanged from 0009.
  CHECK (
    (action = 'skip' AND media_type IS NULL AND resizing_strategy IS NULL AND output_type IS NULL
      AND image_width IS NULL AND image_height IS NULL AND shorter_side IS NULL
      AND tile_row_count IS NULL AND tile_column_count IS NULL
      AND frame_count IS NULL AND frame_delay_ms IS NULL)
    OR (media_type = 'image' AND resizing_strategy = 'fit_to_box' AND output_type IS NULL
      AND image_width IS NOT NULL AND image_height IS NOT NULL AND shorter_side IS NULL
      AND tile_row_count IS NULL AND tile_column_count IS NULL
      AND frame_count IS NULL AND frame_delay_ms IS NULL)
    OR (media_type = 'image' AND resizing_strategy = 'resize_shorter_side' AND output_type IS NULL
      AND shorter_side IS NOT NULL AND image_width IS NULL AND image_height IS NULL
      AND tile_row_count IS NULL AND tile_column_count IS NULL
      AND frame_count IS NULL AND frame_delay_ms IS NULL)
    OR (media_type = 'video' AND output_type = 'mosaic' AND resizing_strategy IS NULL
      AND shorter_side IS NOT NULL AND tile_row_count IS NOT NULL AND tile_column_count IS NOT NULL
      AND image_width IS NULL AND image_height IS NULL
      AND frame_count IS NULL AND frame_delay_ms IS NULL)
    OR (media_type = 'video' AND output_type = 'preview' AND resizing_strategy IS NULL
      AND shorter_side IS NOT NULL AND frame_count IS NOT NULL AND frame_delay_ms IS NOT NULL
      AND image_width IS NULL AND image_height IS NULL
      AND tile_row_count IS NULL AND tile_column_count IS NULL)
  ),
  -- 2. Encoding columns must match output_mime. Unchanged from 0009.
  CHECK (
    (action = 'skip' AND output_mime IS NULL
      AND jpeg_quality IS NULL AND png_compression_level IS NULL
      AND webp_quality IS NULL AND webp_lossless IS NULL
      AND gif_max_colors IS NULL AND gif_dither IS NULL)
    OR (output_mime = 'image/jpeg' AND jpeg_quality IS NOT NULL
      AND png_compression_level IS NULL AND webp_quality IS NULL AND webp_lossless IS NULL
      AND gif_max_colors IS NULL AND gif_dither IS NULL)
    OR (output_mime = 'image/png' AND png_compression_level IS NOT NULL
      AND jpeg_quality IS NULL AND webp_quality IS NULL AND webp_lossless IS NULL
      AND gif_max_colors IS NULL AND gif_dither IS NULL)
    OR (output_mime = 'image/webp' AND webp_quality IS NOT NULL AND webp_lossless IS NOT NULL
      AND jpeg_quality IS NULL AND png_compression_level IS NULL
      AND gif_max_colors IS NULL AND gif_dither IS NULL)
    OR (output_mime = 'image/gif' AND gif_max_colors IS NOT NULL AND gif_dither IS NOT NULL
      AND jpeg_quality IS NULL AND png_compression_level IS NULL
      AND webp_quality IS NULL AND webp_lossless IS NULL)
  ),
  -- 3. Which encodings are legal for which sizing branch. Unchanged from 0009.
  CHECK (
    action = 'skip'
    OR media_type = 'image'
    OR (output_type = 'mosaic' AND output_mime IN ('image/jpeg', 'image/png', 'image/webp'))
    OR (output_type = 'preview' AND output_mime IN ('image/gif', 'image/webp'))
  )
);

-- Every column but mime_types carries over unchanged -- a 'skip' row's
-- mime_types is dropped to NULL (it was always redundant: 'skip' already
-- matches by glob alone in resolvePolicies, this migration just makes the
-- schema/scan agree with that instead of carrying a filter nothing
-- consulted for anything but an extra, avoidable media probe); a
-- 'generate' row's mime_types is untouched.
INSERT INTO thumbnail_policies_new (
  id, name, glob, action, mime_types, media_type,
  resizing_strategy, image_width, image_height, shorter_side,
  output_type, tile_row_count, tile_column_count,
  frame_count, frame_delay_ms,
  output_mime, jpeg_quality, png_compression_level, webp_quality, webp_lossless,
  gif_max_colors, gif_dither, created_at
)
SELECT
  id, name, glob, action,
  CASE WHEN action = 'skip' THEN NULL ELSE mime_types END,
  media_type,
  resizing_strategy, image_width, image_height, shorter_side,
  output_type, tile_row_count, tile_column_count,
  frame_count, frame_delay_ms,
  output_mime, jpeg_quality, png_compression_level, webp_quality, webp_lossless,
  gif_max_colors, gif_dither, created_at
FROM thumbnail_policies;

DROP TABLE thumbnail_policies;
ALTER TABLE thumbnail_policies_new RENAME TO thumbnail_policies;
