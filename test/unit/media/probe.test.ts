import { describe, it, expect } from "vitest";
import { resolveRotationDegrees, rotationSwapsDimensions } from "../../../src/media/probe.js";

describe("resolveRotationDegrees", () => {
  it("reads side_data_list's rotation when present", () => {
    expect(resolveRotationDegrees({ side_data_list: [{ rotation: -90 }] })).toBe(-90);
  });

  it("falls back to the legacy tags.rotate convention when there's no side data", () => {
    expect(resolveRotationDegrees({ tags: { rotate: "180" } })).toBe(180);
  });

  it("prefers side_data_list over tags.rotate when both are present", () => {
    // Not a real-world combination (a real encode only ever produces one or
    // the other for the same file), but the precedence rule itself is only
    // testable this way.
    expect(
      resolveRotationDegrees({ side_data_list: [{ rotation: 270 }], tags: { rotate: "90" } }),
    ).toBe(270);
  });

  it("returns 0 when neither side data nor a rotate tag is present", () => {
    expect(resolveRotationDegrees({})).toBe(0);
  });

  it("skips a side_data_list entry with no rotation field and falls through to tags.rotate", () => {
    expect(
      resolveRotationDegrees({
        side_data_list: [{}],
        tags: { rotate: "90" },
      }),
    ).toBe(90);
  });

  it("returns 0 for a non-numeric tags.rotate value rather than NaN", () => {
    expect(resolveRotationDegrees({ tags: { rotate: "not-a-number" } })).toBe(0);
  });
});

describe("rotationSwapsDimensions", () => {
  it("swaps for 90 and 270", () => {
    expect(rotationSwapsDimensions(90)).toBe(true);
    expect(rotationSwapsDimensions(270)).toBe(true);
  });

  it("swaps for the negative equivalents -90 and -270", () => {
    expect(rotationSwapsDimensions(-90)).toBe(true);
    expect(rotationSwapsDimensions(-270)).toBe(true);
  });

  it("never swaps for 180 or its negative equivalent -180", () => {
    expect(rotationSwapsDimensions(180)).toBe(false);
    expect(rotationSwapsDimensions(-180)).toBe(false);
  });

  it("never swaps for 0 or a full-turn-equivalent 360", () => {
    expect(rotationSwapsDimensions(0)).toBe(false);
    expect(rotationSwapsDimensions(360)).toBe(false);
  });

  it("normalizes an out-of-range angle before checking (450 == 90)", () => {
    expect(rotationSwapsDimensions(450)).toBe(true);
  });
});
