import { describe, it, expect } from "vitest";
import {
  classifyArchiveStatus,
  isColderTarget,
  isSupportedStorageClass,
} from "../../../src/s3/archive-status.js";

const NOW = new Date("2026-06-15T00:00:00Z");

describe("classifyArchiveStatus", () => {
  it("is 'immediate' when there's no StorageClass field (default STANDARD)", () => {
    expect(classifyArchiveStatus({}, NOW)).toBe("immediate");
  });

  it("is 'immediate' for an explicit STANDARD class", () => {
    expect(classifyArchiveStatus({ storageClass: "STANDARD" }, NOW)).toBe("immediate");
  });

  it("is 'needs-restore-request' for a cold class with no Restore header", () => {
    expect(classifyArchiveStatus({ storageClass: "GLACIER" }, NOW)).toBe("needs-restore-request");
    expect(classifyArchiveStatus({ storageClass: "DEEP_ARCHIVE" }, NOW)).toBe(
      "needs-restore-request",
    );
  });

  it("is 'restore-ongoing' when a restore is in progress", () => {
    const head = { storageClass: "GLACIER", restore: 'ongoing-request="true"' };
    expect(classifyArchiveStatus(head, NOW)).toBe("restore-ongoing");
  });

  it("is 'restore-ready' when a restore completed and hasn't expired", () => {
    const head = {
      storageClass: "DEEP_ARCHIVE",
      restore: 'ongoing-request="false", expiry-date="Wed, 01 Jul 2026 00:00:00 GMT"',
    };
    expect(classifyArchiveStatus(head, NOW)).toBe("restore-ready");
  });

  it("is 'restore-expired-needs-reissue' when the restored copy's expiry has passed", () => {
    const head = {
      storageClass: "DEEP_ARCHIVE",
      restore: 'ongoing-request="false", expiry-date="Wed, 01 Jan 2026 00:00:00 GMT"',
    };
    expect(classifyArchiveStatus(head, NOW)).toBe("restore-expired-needs-reissue");
  });
});

describe("isColderTarget", () => {
  it("orders STANDARD < GLACIER < DEEP_ARCHIVE", () => {
    expect(isColderTarget("STANDARD", "GLACIER")).toBe(true);
    expect(isColderTarget("STANDARD", "DEEP_ARCHIVE")).toBe(true);
    expect(isColderTarget("GLACIER", "DEEP_ARCHIVE")).toBe(true);
    expect(isColderTarget("GLACIER", "STANDARD")).toBe(false);
    expect(isColderTarget("DEEP_ARCHIVE", "GLACIER")).toBe(false);
    expect(isColderTarget("STANDARD", "STANDARD")).toBe(false);
  });
});

describe("isSupportedStorageClass", () => {
  it("accepts exactly the three supported classes", () => {
    expect(isSupportedStorageClass("STANDARD")).toBe(true);
    expect(isSupportedStorageClass("GLACIER")).toBe(true);
    expect(isSupportedStorageClass("DEEP_ARCHIVE")).toBe(true);
    expect(isSupportedStorageClass("GLACIER_IR")).toBe(false);
    expect(isSupportedStorageClass("REDUCED_REDUNDANCY")).toBe(false);
    expect(isSupportedStorageClass("")).toBe(false);
  });
});
