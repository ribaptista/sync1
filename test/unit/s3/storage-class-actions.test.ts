import { describe, it, expect } from "vitest";
import { decideStorageClassAction } from "../../../src/s3/storage-class-actions.js";

describe("decideStorageClassAction", () => {
  it("is already-correct when current already matches target", () => {
    expect(decideStorageClassAction("GLACIER", "GLACIER", "needs-restore-request")).toEqual({
      kind: "already-correct",
    });
  });

  it("is immediate-copy for any colder target, regardless of archive status", () => {
    expect(decideStorageClassAction("STANDARD", "GLACIER", "immediate")).toEqual({
      kind: "immediate-copy",
    });
    expect(decideStorageClassAction("STANDARD", "DEEP_ARCHIVE", "immediate")).toEqual({
      kind: "immediate-copy",
    });
    expect(decideStorageClassAction("GLACIER", "DEEP_ARCHIVE", "needs-restore-request")).toEqual({
      kind: "immediate-copy",
    });
  });

  describe("warmer target (needs the restore dance)", () => {
    it("requests a restore when not yet requested", () => {
      expect(decideStorageClassAction("GLACIER", "STANDARD", "needs-restore-request")).toEqual({
        kind: "needs-restore-request",
      });
    });

    it("requests a fresh restore when the previous one expired", () => {
      expect(
        decideStorageClassAction("DEEP_ARCHIVE", "STANDARD", "restore-expired-needs-reissue"),
      ).toEqual({ kind: "needs-restore-request" });
    });

    it("is a no-op while a restore is already in progress", () => {
      expect(decideStorageClassAction("GLACIER", "STANDARD", "restore-ongoing")).toEqual({
        kind: "restore-ongoing",
      });
    });

    it("finalizes with a copy once the restore is ready", () => {
      expect(decideStorageClassAction("DEEP_ARCHIVE", "GLACIER", "restore-ready")).toEqual({
        kind: "finalize-copy",
      });
    });
  });
});
