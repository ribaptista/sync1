import { COLDNESS_ORDER, type SupportedStorageClass } from "./archive-status.js";
import { matchesAnyGlob } from "../fs/glob-match.js";
import type { StoragePolicyRow } from "../db/repositories/storage-policies-repository.js";

export interface HashPolicyEvaluation {
  targetClass: SupportedStorageClass;
  /**
   * True when this hash's referencing paths disagreed on the target
   * class -- `targetClass` is the warmest of those disagreeing targets,
   * chosen so a shared (deduped) object is never archived colder than any
   * path that wants it kept warm, but the disagreement itself is worth
   * surfacing (see docs/architecture/ignore-and-storage-policies.md).
   */
  conflicted: boolean;
}

/**
 * Resolves a single path's target class: the first matching non-default
 * policy, in priority order (lower first), else the default policy.
 * `nonDefaultPoliciesByPriority` must already be sorted by priority (e.g.
 * `StoragePoliciesRepository.listNonDefaultByPriority()`); this function
 * does no I/O and doesn't re-sort, so it stays trivially unit-testable.
 */
export function evaluatePathTargetClass(
  path: string,
  nonDefaultPoliciesByPriority: readonly StoragePolicyRow[],
  defaultPolicy: StoragePolicyRow,
): SupportedStorageClass {
  for (const policy of nonDefaultPoliciesByPriority) {
    if (policy.glob !== null && matchesAnyGlob(path, [policy.glob]).matched) {
      return policy.target_class;
    }
  }
  return defaultPolicy.target_class;
}

/**
 * Resolves one hash's overall target class from every path that
 * references it: each path's target is evaluated independently
 * (`evaluatePathTargetClass`), then reduced to a single warmest-wins
 * target -- since one S3 object can be referenced by several paths
 * (dedup), and two paths matching different policies could otherwise
 * imply different classes for the very same object.
 */
export function resolveHashTargetClass(
  paths: readonly string[],
  nonDefaultPoliciesByPriority: readonly StoragePolicyRow[],
  defaultPolicy: StoragePolicyRow,
): HashPolicyEvaluation {
  if (paths.length === 0) {
    throw new Error("resolveHashTargetClass: at least one referencing path is required");
  }

  const perPathTargets = paths.map((p) =>
    evaluatePathTargetClass(p, nonDefaultPoliciesByPriority, defaultPolicy),
  );

  let warmest = perPathTargets[0]!;
  for (const target of perPathTargets) {
    if (COLDNESS_ORDER[target] < COLDNESS_ORDER[warmest]) warmest = target;
  }
  const conflicted = perPathTargets.some((target) => target !== warmest);

  return { targetClass: warmest, conflicted };
}
