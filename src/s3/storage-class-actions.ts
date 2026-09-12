import type { ArchiveStatus, SupportedStorageClass } from "./archive-status.js";
import { isColderTarget } from "./archive-status.js";

export type StorageClassAction =
  | { kind: "already-correct" }
  | { kind: "immediate-copy" }
  | { kind: "needs-restore-request" }
  | { kind: "restore-ongoing" }
  | { kind: "finalize-copy" };

/**
 * Pure decision for `ensure_storage_class`, given an object's current class,
 * the requested target class, and its current archive/restore status
 * (`classifyArchiveStatus`). Colder-target moves are always immediate
 * (a plain self-copy); warmer-target moves need the two-phase
 * restore-then-finalize dance.
 */
export function decideStorageClassAction(
  currentClass: SupportedStorageClass,
  targetClass: SupportedStorageClass,
  archiveStatus: ArchiveStatus,
): StorageClassAction {
  if (currentClass === targetClass) return { kind: "already-correct" };

  if (isColderTarget(currentClass, targetClass)) {
    return { kind: "immediate-copy" };
  }

  // Target is warmer than current -- current must be a cold class, so
  // archiveStatus reflects its restore state.
  switch (archiveStatus) {
    case "immediate":
      // Shouldn't happen (current is cold whenever target is warmer than
      // it), but if it somehow does, there's nothing more to do.
      return { kind: "already-correct" };
    case "needs-restore-request":
    case "restore-expired-needs-reissue":
      return { kind: "needs-restore-request" };
    case "restore-ongoing":
      return { kind: "restore-ongoing" };
    case "restore-ready":
      return { kind: "finalize-copy" };
  }
}
