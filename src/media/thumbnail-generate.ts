export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Beyond this source-to-box aspect-ratio ratio, standard contain-fit would
 * squeeze the short output dimension to less than half of the box's own
 * short bound -- past that point we'd rather let the long dimension
 * overflow the box than keep shrinking the short one toward zero. Exact
 * derivation: contain-fit's short output dimension is
 * `boxShort * (boxRatio / sourceRatio)` whenever `sourceRatio >= boxRatio`
 * (no degeneracy at all when `sourceRatio <= boxRatio`), so it equals
 * `boxShort / 2` exactly when `sourceRatio == 2 * boxRatio` -- the natural,
 * precisely unit-testable threshold for "lost more than half its value".
 */
const EXTREME_RATIO_MULTIPLIER = 2;

/**
 * Computes the resized dimensions for fitting `source` within `box`,
 * preserving aspect ratio and never distorting -- see the design notes
 * above `EXTREME_RATIO_MULTIPLIER`. Orientation-aware: the box's
 * width/height are swapped internally (`effectiveBox`) so its long axis
 * always aligns with the source's long axis, regardless of how the box's
 * own width/height happen to be configured -- a portrait source always
 * gets a portrait-shaped effective box. In the ordinary case this is a
 * standard "contain" fit; in the extreme-aspect-ratio case (see
 * `EXTREME_RATIO_MULTIPLIER`), the short output side is instead forced to
 * exactly the box's own short bound, and the long side is left to overflow
 * the box's other bound -- never cropped, never distorted.
 */
export function computeContainFitSize(source: Dimensions, box: Dimensions): Dimensions {
  const sourceIsLandscape = source.width >= source.height;
  const boxIsLandscape = box.width >= box.height;
  const effectiveBox: Dimensions =
    sourceIsLandscape === boxIsLandscape ? box : { width: box.height, height: box.width };

  const sourceRatio = Math.max(source.width, source.height) / Math.min(source.width, source.height);
  const boxRatio =
    Math.max(effectiveBox.width, effectiveBox.height) /
    Math.min(effectiveBox.width, effectiveBox.height);

  const scale =
    sourceRatio > EXTREME_RATIO_MULTIPLIER * boxRatio
      ? Math.min(effectiveBox.width, effectiveBox.height) / Math.min(source.width, source.height)
      : Math.min(effectiveBox.width / source.width, effectiveBox.height / source.height);

  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}
