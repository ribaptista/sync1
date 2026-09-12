import { randomBytes } from "node:crypto";

/**
 * Unique but not required to be lexicographically sortable — true commit
 * ordering comes from the versions table's `sequence` column (see
 * docs/architecture/vault-and-encryption.md), not from parsing this string,
 * so it's immune to cross-machine clock skew.
 */
export function generateVersionStamp(): string {
  const ts = new Date().toISOString().replace(/[-:.]/g, "");
  const rand = randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}
