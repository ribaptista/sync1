-- Rebuild (create-copy-drop-rename), same rationale as 0007/0008. No
-- production vault has ever had a configured thumbnail policy, so this
-- never actually migrates real rows -- but it's still written as a real
-- reshape.
--
-- Two independent axes replace the previous ad hoc field grouping:
--
-- - SIZING (how many pixels the output has): image/fit_to_box,
--   image/resize_shorter_side, video/mosaic, video/preview (renamed from
--   'gif' -- output_mime now picks GIF vs animated WebP for it). `tile_size`
--   is merged into `shorter_side`: both were always the same operation
--   (scale so the shorter side lands on a target, aspect ratio otherwise
--   preserved), fed to the same computeShorterSideFitSize call either way.
--   `shorter_side` means one *output unit's* shorter side -- for a mosaic
--   that's one tile's, not the composed grid's.
-- - ENCODING (how those pixels are compressed): image/jpeg, image/png,
--   image/webp, image/gif -- now a required `output_mime` on every
--   'generate' row, never inferred from the source. Previously an image
--   thumbnail silently inherited the original's own extension, which
--   both produced unbrowsable formats (.tiff) and, for a source
--   ImageMagick can't write (HEIC), failed generation on every run
--   forever. Making the format an explicit, validated field removes both
--   failure modes by construction.
--
-- The two axes are independent, so the CHECK constraint stays two
-- separate clauses (sizing, encoding) plus a small legality gate, rather
-- than one flat matrix naming all ~14 legal combinations directly.
--
-- Legal encodings per sizing branch: an image (either resizing strategy)
-- may be any of the four; a mosaic (a single still composite) may be
-- jpeg/png/webp, never gif (a one-frame "animation" is strictly worse
-- than any alternative); a preview (always animated) may only be
-- gif/webp, never jpeg/png (a preview is never a still).
CREATE TABLE thumbnail_policies_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE CHECK (length(name) > 0 AND name NOT GLOB '*[^A-Za-z0-9_]*'),
  glob TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('skip', 'generate')),
  -- JSON-encoded array of mime-type patterns, e.g. ["image/jpeg","video/*"].
  -- The subtype segment may be a literal "*" wildcard; the type segment
  -- never is (this is not a general glob). This is the *source* mime
  -- filter (what this policy matches against) -- unrelated to
  -- `output_mime` below (what it produces). Parsed/serialized at the
  -- repository boundary, never queried through SQL.
  mime_types TEXT NOT NULL,
  -- 'image' or 'video', NULL for a 'skip' row -- which sizing-field
  -- subset below applies to a 'generate' row. Validated against every
  -- mime_types entry's own type segment at the repository layer, which is
  -- what proves a matched policy's media type agrees with what was
  -- actually probed.
  media_type TEXT CHECK (media_type IS NULL OR media_type IN ('image', 'video')),
  -- SIZING axis. 'image' rows pick a resizing_strategy; 'video' rows pick
  -- an output_type; the two are mutually exclusive (see the CHECK below).
  resizing_strategy TEXT CHECK (resizing_strategy IS NULL OR resizing_strategy IN ('fit_to_box', 'resize_shorter_side')),
  image_width INTEGER CHECK (image_width IS NULL OR image_width > 0),
  image_height INTEGER CHECK (image_height IS NULL OR image_height > 0),
  -- One output unit's shorter side, in pixels -- the image
  -- resize_shorter_side strategy's own target, one mosaic tile's shorter
  -- side, or one preview frame's shorter side. The longer side always
  -- falls out of the source's own aspect ratio, never configured
  -- independently. Replaces the old video-only `tile_size` column -- see
  -- the header comment above.
  shorter_side INTEGER CHECK (shorter_side IS NULL OR shorter_side > 0),
  output_type TEXT CHECK (output_type IS NULL OR output_type IN ('mosaic', 'preview')),
  tile_row_count INTEGER CHECK (tile_row_count IS NULL OR tile_row_count > 0),
  tile_column_count INTEGER CHECK (tile_column_count IS NULL OR tile_column_count > 0),
  frame_count INTEGER CHECK (frame_count IS NULL OR frame_count > 0),
  -- Each frame's on-screen display duration, in milliseconds. Realized as
  -- an input framerate (1000 / frame_delay_ms), since neither GIF nor
  -- animated WebP takes a per-frame duration flag directly. GIF stores
  -- the result in centiseconds (10ms floor, every value rounds; browsers
  -- additionally clamp a stored 0-1cs delay to 100ms), animated WebP
  -- stores milliseconds exactly -- see docs/architecture/thumbnails.md.
  frame_delay_ms INTEGER CHECK (frame_delay_ms IS NULL OR frame_delay_ms > 0),
  -- ENCODING axis: which of the four field groups below is populated is
  -- determined entirely by output_mime, independent of every sizing
  -- column above -- see the CHECK below.
  output_mime TEXT CHECK (output_mime IS NULL OR output_mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  jpeg_quality INTEGER CHECK (jpeg_quality IS NULL OR (jpeg_quality BETWEEN 1 AND 100)),
  -- zlib compression effort, 0 (fastest) to 9 (smallest) -- lossless
  -- either way, this only trades encode time for file size (measured:
  -- ~1-15% on real content). Deliberately NOT paired with a palette/color
  -- -count option: that would duplicate what output_mime = 'image/gif'
  -- already is, and would be this schema's first genuinely optional
  -- field. PNG stays lossless truecolor; GIF is the palette option.
  png_compression_level INTEGER CHECK (png_compression_level IS NULL OR (png_compression_level BETWEEN 0 AND 9)),
  webp_quality INTEGER CHECK (webp_quality IS NULL OR (webp_quality BETWEEN 1 AND 100)),
  webp_lossless INTEGER CHECK (webp_lossless IS NULL OR webp_lossless IN (0, 1)),
  gif_max_colors INTEGER CHECK (gif_max_colors IS NULL OR (gif_max_colors BETWEEN 2 AND 256)),
  -- ffmpeg's paletteuse dither modes, used verbatim for a 'preview'
  -- row's own GIF encoding. For a still 'image'/'gif' row (ImageMagick,
  -- not ffmpeg), only 'none' and 'floyd_steinberg' have a direct
  -- equivalent (`-dither None`/`-dither FloydSteinberg`); every other
  -- value maps to FloydSteinberg there too, since ImageMagick has no
  -- comparable second error-diffusion mode. Kept as ffmpeg's full enum
  -- rather than the two-value intersection so the video path doesn't
  -- lose real capability (bayer compresses far better; sierra2_4a
  -- generally looks better) -- see docs/architecture/thumbnails.md.
  gif_dither TEXT CHECK (gif_dither IS NULL OR gif_dither IN
    ('none', 'bayer', 'heckbert', 'floyd_steinberg', 'sierra2', 'sierra2_4a', 'sierra3', 'burkes', 'atkinson')),
  created_at TEXT NOT NULL,
  -- 1. Sizing columns must match (media_type, resizing_strategy | output_type).
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
  -- 2. Encoding columns must match output_mime. Independent of every sizing column above.
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
  -- 3. Which encodings are legal for which sizing branch -- the only place the two axes meet.
  CHECK (
    action = 'skip'
    OR media_type = 'image'
    OR (output_type = 'mosaic' AND output_mime IN ('image/jpeg', 'image/png', 'image/webp'))
    OR (output_type = 'preview' AND output_mime IN ('image/gif', 'image/webp'))
  )
);

-- Never exercised against real data (see above). Every pre-existing row
-- was a 'generate'+'image' row (fit_to_box or resize_shorter_side,
-- unchanged either way) or a 'generate'+'video' row -- 'mosaic' unchanged
-- (its old tile_size carries into the new shared shorter_side column),
-- 'gif' renamed to 'preview'. No pre-existing row had an output_mime at
-- all, so every migrated row is given the format its old behavior
-- actually produced: JPEG for every image/mosaic row (the old hardcoded
-- output), GIF for every old 'gif' row, with this migration's own default
-- encoding settings (see the CLI's matching defaults).
INSERT INTO thumbnail_policies_new (
  id, name, glob, action, mime_types, media_type,
  resizing_strategy, image_width, image_height, shorter_side,
  output_type, tile_row_count, tile_column_count,
  frame_count, frame_delay_ms,
  output_mime, jpeg_quality, png_compression_level, webp_quality, webp_lossless,
  gif_max_colors, gif_dither, created_at
)
SELECT
  id, name, glob, action, mime_types, media_type,
  resizing_strategy, image_width, image_height,
  -- Old `tile_size` served both video branches (mosaic and gif); old
  -- `shorter_side` served only image/resize_shorter_side. Never both set
  -- on the same row under the 0008 shape, so this is an unambiguous pick.
  CASE WHEN media_type = 'video' THEN tile_size ELSE shorter_side END,
  CASE WHEN output_type = 'gif' THEN 'preview' ELSE output_type END,
  tile_row_count, tile_column_count,
  frame_count, frame_delay_ms,
  CASE
    WHEN action = 'generate' AND output_type = 'gif' THEN 'image/gif'
    WHEN action = 'generate' THEN 'image/jpeg'
  END,
  -- Every generate row except the old 'gif' branch used jpeg_quality.
  -- `output_type != 'gif'` would be NULL (not TRUE) for every image row,
  -- since output_type itself is NULL there -- IS NOT triggers correctly
  -- under three-valued logic where a plain != does not.
  CASE WHEN action = 'generate' AND output_type IS NOT 'gif' THEN COALESCE(jpeg_quality, 80) END,
  NULL, NULL, NULL,
  CASE WHEN action = 'generate' AND output_type = 'gif' THEN 256 END,
  CASE WHEN action = 'generate' AND output_type = 'gif' THEN 'sierra2_4a' END,
  created_at
FROM thumbnail_policies;

DROP TABLE thumbnail_policies;
ALTER TABLE thumbnail_policies_new RENAME TO thumbnail_policies;
