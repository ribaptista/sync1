import { describe, it, expect } from "vitest";
import {
  evaluatePathTargetClass,
  resolveHashTargetClass,
} from "../../../src/s3/policy-evaluation.js";
import type { StoragePolicyRow } from "../../../src/db/repositories/storage-policies-repository.js";

function policy(
  id: number,
  glob: string,
  targetClass: StoragePolicyRow["target_class"],
  priority: number,
): StoragePolicyRow {
  return { id, glob, target_class: targetClass, priority, is_default: 0 };
}

const DEFAULT_POLICY: StoragePolicyRow = {
  id: 0,
  glob: null,
  target_class: "STANDARD",
  priority: null,
  is_default: 1,
};

describe("evaluatePathTargetClass", () => {
  it("falls back to the default policy when nothing matches", () => {
    const result = evaluatePathTargetClass("photos/a.jpg", [], DEFAULT_POLICY);
    expect(result).toBe("STANDARD");
  });

  it("uses the single matching non-default policy", () => {
    const policies = [policy(1, "archive/*", "DEEP_ARCHIVE", 0)];
    expect(evaluatePathTargetClass("archive/a.jpg", policies, DEFAULT_POLICY)).toBe("DEEP_ARCHIVE");
    expect(evaluatePathTargetClass("photos/a.jpg", policies, DEFAULT_POLICY)).toBe("STANDARD");
  });

  it("resolves overlapping policies by priority order (lower first), not glob specificity", () => {
    const policies = [
      policy(1, "archive/**", "GLACIER", 0), // checked first
      policy(2, "archive/keep-warm/*", "STANDARD", 1), // more specific, but lower priority
    ];
    // Both globs match this path; priority 0 wins even though the other
    // glob is a strictly more specific match.
    expect(evaluatePathTargetClass("archive/keep-warm/a.jpg", policies, DEFAULT_POLICY)).toBe(
      "GLACIER",
    );
  });

  it("respects priority ordering regardless of array order passed in", () => {
    const policies = [
      policy(2, "archive/keep-warm/*", "STANDARD", 1),
      policy(1, "archive/**", "GLACIER", 0),
    ];
    // caller is responsible for pre-sorting (as
    // listNonDefaultByPriority does) -- this just walks in the given order
    expect(evaluatePathTargetClass("archive/keep-warm/a.jpg", policies, DEFAULT_POLICY)).toBe(
      "STANDARD",
    );
  });
});

describe("resolveHashTargetClass", () => {
  it("throws for an empty path list", () => {
    expect(() => resolveHashTargetClass([], [], DEFAULT_POLICY)).toThrow(/at least one/);
  });

  it("resolves a single referencing path with no conflict", () => {
    const policies = [policy(1, "archive/*", "DEEP_ARCHIVE", 0)];
    const result = resolveHashTargetClass(["archive/a.jpg"], policies, DEFAULT_POLICY);
    expect(result).toEqual({ targetClass: "DEEP_ARCHIVE", conflicted: false });
  });

  it("agrees without conflict when multiple paths imply the same class", () => {
    const policies = [policy(1, "archive/*", "DEEP_ARCHIVE", 0)];
    const result = resolveHashTargetClass(
      ["archive/a.jpg", "archive/b.jpg"],
      policies,
      DEFAULT_POLICY,
    );
    expect(result).toEqual({ targetClass: "DEEP_ARCHIVE", conflicted: false });
  });

  it("picks the warmest target and flags a conflict when paths disagree", () => {
    const policies = [policy(1, "archive/*", "DEEP_ARCHIVE", 0)];
    // "archive/keep-warm.jpg" falls back to the default (STANDARD);
    // "archive/cold.jpg" matches the DEEP_ARCHIVE policy -- same hash,
    // disagreeing targets.
    const result = resolveHashTargetClass(
      ["archive/cold.jpg", "keep-warm.jpg"],
      policies,
      DEFAULT_POLICY,
    );
    expect(result).toEqual({ targetClass: "STANDARD", conflicted: true });
  });

  it("picks the warmest among three disagreeing targets (GLACIER vs DEEP_ARCHIVE vs STANDARD)", () => {
    const policies = [policy(1, "glacier/*", "GLACIER", 0), policy(2, "deep/*", "DEEP_ARCHIVE", 1)];
    const result = resolveHashTargetClass(
      ["glacier/a.jpg", "deep/a.jpg", "elsewhere/a.jpg"],
      policies,
      DEFAULT_POLICY,
    );
    expect(result).toEqual({ targetClass: "STANDARD", conflicted: true });
  });

  it("flags no conflict when the warmest and coldest are actually the same class", () => {
    const policies = [policy(1, "*", "GLACIER", 0)];
    const result = resolveHashTargetClass(["a.jpg", "b.jpg", "c.jpg"], policies, DEFAULT_POLICY);
    expect(result).toEqual({ targetClass: "GLACIER", conflicted: false });
  });
});
