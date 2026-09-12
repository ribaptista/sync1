/**
 * Classifies an S3 object's archive/restore state from a HEAD response,
 * purely from `StorageClass` + the `x-amz-restore` header -- no I/O, so
 * this is exhaustively unit-testable against fabricated HEAD responses.
 * LocalStack won't simulate real archive-tier timing (a multi-hour Glacier
 * restore), so this classification logic is what actually gets tested for
 * the "ongoing"/"ready"/"expired" states; e2e only covers the immediate
 * (non-restore) path and that the right API calls get issued.
 */
export type ArchiveStatus =
  | "immediate"
  | "needs-restore-request"
  | "restore-ongoing"
  | "restore-ready"
  | "restore-expired-needs-reissue";

export type SupportedStorageClass = "STANDARD" | "GLACIER" | "DEEP_ARCHIVE";

const COLDNESS_ORDER: Record<SupportedStorageClass, number> = {
  STANDARD: 0,
  GLACIER: 1,
  DEEP_ARCHIVE: 2,
};

const COLD_CLASSES = new Set<string>(["GLACIER", "DEEP_ARCHIVE"]);

export function isColderTarget(
  current: SupportedStorageClass,
  target: SupportedStorageClass,
): boolean {
  return COLDNESS_ORDER[target] > COLDNESS_ORDER[current];
}

export function isSupportedStorageClass(value: string): value is SupportedStorageClass {
  return value === "STANDARD" || value === "GLACIER" || value === "DEEP_ARCHIVE";
}

interface ParsedRestoreHeader {
  ongoing: boolean;
  expiryDate: Date | undefined;
}

/** Parses `x-amz-restore`, e.g. `ongoing-request="false", expiry-date="Fri, 23 Dec 2022 00:00:00 GMT"`. */
function parseRestoreHeader(restore: string): ParsedRestoreHeader {
  const ongoingMatch = /ongoing-request="(true|false)"/.exec(restore);
  const expiryMatch = /expiry-date="([^"]+)"/.exec(restore);
  return {
    ongoing: ongoingMatch?.[1] === "true",
    expiryDate: expiryMatch?.[1] !== undefined ? new Date(expiryMatch[1]) : undefined,
  };
}

export interface HeadForClassification {
  storageClass?: string;
  restore?: string;
}

export function classifyArchiveStatus(
  head: HeadForClassification,
  now: Date = new Date(),
): ArchiveStatus {
  const storageClass = head.storageClass ?? "STANDARD";
  if (!COLD_CLASSES.has(storageClass)) return "immediate";

  if (!head.restore) return "needs-restore-request";

  const parsed = parseRestoreHeader(head.restore);
  if (parsed.ongoing) return "restore-ongoing";
  if (parsed.expiryDate && parsed.expiryDate.getTime() > now.getTime()) {
    return "restore-ready";
  }
  return "restore-expired-needs-reissue";
}
