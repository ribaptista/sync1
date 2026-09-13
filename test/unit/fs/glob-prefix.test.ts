import { describe, it, expect } from "vitest";
import { literalPrefixOf } from "../../../src/fs/glob-prefix.js";

describe("literalPrefixOf", () => {
  it("returns the leading literal directory run for a pattern like 'Photos/**'", () => {
    expect(literalPrefixOf("Photos/**")).toBe("Photos");
  });

  it("returns '' when the first segment already has a wildcard", () => {
    expect(literalPrefixOf("**/xyz/*")).toBe("");
    expect(literalPrefixOf("*.jpg")).toBe("");
  });

  it("returns the full pattern when it has no wildcards at all", () => {
    expect(literalPrefixOf("a/b/c.txt")).toBe("a/b/c.txt");
  });

  it("stops at the first segment containing '*', '?', or '['", () => {
    expect(literalPrefixOf("a/b/*.jpg")).toBe("a/b");
    expect(literalPrefixOf("a/b?/c.jpg")).toBe("a");
    expect(literalPrefixOf("a/[abc]/c.jpg")).toBe("a");
  });

  it("stops correctly for a wildcard nested several levels deep", () => {
    expect(literalPrefixOf("a/b/c/d/**/e.jpg")).toBe("a/b/c/d");
  });

  it("returns '' for a lone '*' or '**'", () => {
    expect(literalPrefixOf("*")).toBe("");
    expect(literalPrefixOf("**")).toBe("");
  });
});
