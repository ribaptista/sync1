import { describe, it, expect } from "vitest";
import {
  computeContainFitSize,
  computeMosaicFrameSize,
} from "../../../src/media/thumbnail-generate.js";

describe("computeContainFitSize", () => {
  it("does a standard contain fit for an ordinary landscape source into a square box", () => {
    expect(computeContainFitSize({ width: 800, height: 600 }, { width: 400, height: 400 })).toEqual(
      { width: 400, height: 300 },
    );
  });

  it("swaps the box's width/height to align with a portrait source's orientation", () => {
    // Box is configured landscape (400x300), but the source is portrait --
    // without the swap this would waste box space (225x300); with it, the
    // box's long dimension (400) aligns with the source's long side.
    const withSwap = computeContainFitSize(
      { width: 600, height: 800 },
      { width: 400, height: 300 },
    );
    expect(withSwap).toEqual({ width: 300, height: 400 });
  });

  it("stays a normal contain fit exactly at the sourceRatio == 2*boxRatio boundary", () => {
    // box 100x100 (boxRatio 1), source 200x100 (sourceRatio 2 == 2*1) --
    // right at the threshold, still the ordinary formula.
    expect(computeContainFitSize({ width: 200, height: 100 }, { width: 100, height: 100 })).toEqual(
      { width: 100, height: 50 },
    );
  });

  it("switches to the extreme-ratio override just past the boundary", () => {
    // sourceRatio 2.01 > 2*boxRatio(1) -- short side forced to the box's
    // own short bound (100), long side allowed to overflow past 100.
    const result = computeContainFitSize({ width: 201, height: 100 }, { width: 100, height: 100 });
    expect(result).toEqual({ width: 201, height: 100 });
  });

  it("fits a square source into an elongated box, bounded by the box's short side", () => {
    expect(computeContainFitSize({ width: 100, height: 100 }, { width: 400, height: 100 })).toEqual(
      { width: 100, height: 100 },
    );
  });

  it("lets an elongated source overflow a square box's long bound (extreme case)", () => {
    // sourceRatio 4 > 2*boxRatio(1) -- extreme override: short side (100)
    // matches the box exactly, long side (400) overflows.
    expect(computeContainFitSize({ width: 400, height: 100 }, { width: 100, height: 100 })).toEqual(
      { width: 400, height: 100 },
    );
  });

  it("handles a degenerate 1x1 source, scaling up to fill the box's short bound", () => {
    expect(computeContainFitSize({ width: 1, height: 1 }, { width: 200, height: 100 })).toEqual({
      width: 100,
      height: 100,
    });
  });

  it("never returns a dimension below 1px", () => {
    const result = computeContainFitSize({ width: 5000, height: 1 }, { width: 1, height: 1 });
    expect(result.width).toBeGreaterThanOrEqual(1);
    expect(result.height).toBeGreaterThanOrEqual(1);
  });
});

describe("computeMosaicFrameSize", () => {
  it("scales a matching-orientation (landscape) source so its short side hits shortSide exactly", () => {
    // 400x300, ratio 4:3 -- min dimension is height (300). scale = 150/300 =
    // 0.5, applied uniformly: 400*0.5=200, 300*0.5=150. Both axes land
    // exactly on an integer, nothing to round.
    expect(computeMosaicFrameSize({ width: 400, height: 300 }, 150)).toEqual({
      width: 200,
      height: 150,
    });
  });

  it("has no orientation concept at all -- a transposed source with the same shortSide produces the exact transpose", () => {
    // 700x500 (landscape): min=500, scale=100/500=0.2 -> {140,100}.
    expect(computeMosaicFrameSize({ width: 700, height: 500 }, 100)).toEqual({
      width: 140,
      height: 100,
    });
    // 500x700 (portrait, same two numbers transposed): min=500 (now the
    // width), same scale 0.2 -> {100,140}, the exact transpose of the
    // landscape result above. Unlike computeContainFitSize, there's no
    // internal box-orientation swap to get right or wrong -- the formula
    // has no pairing between the source's shape and anything else, so
    // transposing the input just transposes the output.
    expect(computeMosaicFrameSize({ width: 500, height: 700 }, 100)).toEqual({
      width: 100,
      height: 140,
    });
  });

  it("rounds the long axis independently when the scale doesn't divide evenly, while the short axis lands exactly on shortSide", () => {
    // 37x82 (portrait): min is width (37). scale = 41/37 = 1.108108...
    // width = 37*scale = 41 exactly (always true of the short axis: min *
    // (shortSide/min) == shortSide, modulo float noise that doesn't land
    // here). height = 82*scale = 90.864864... -- Math.round takes it to
    // 91, independent of the (exact) width computation.
    expect(computeMosaicFrameSize({ width: 37, height: 82 }, 41)).toEqual({
      width: 41,
      height: 91,
    });
  });

  it("scales a square source uniformly on both axes", () => {
    expect(computeMosaicFrameSize({ width: 500, height: 500 }, 125)).toEqual({
      width: 125,
      height: 125,
    });
  });
});
