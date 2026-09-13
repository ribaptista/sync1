import { describe, it, expect } from "vitest";
import { computeContainFitSize } from "../../../src/media/thumbnail-generate.js";

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
