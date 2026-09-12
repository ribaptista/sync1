export interface RemoteLocation {
  bucket: string;
  prefix: string;
}

export function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

export function remoteKey(location: RemoteLocation, relative: string): string {
  const p = normalizePrefix(location.prefix);
  return p ? `${p}/${relative}` : relative;
}

export const VAULT_MANIFEST_KEY = "vault.json";
export const CURRENT_POINTER_KEY = "current";

export function stateSnapshotKey(versionStamp: string): string {
  return `states/${versionStamp}`;
}

/**
 * 2-level sharded prefix (git/restic-style: objects/ab/cd/<hash>), purely
 * for browsability in the S3 console/third-party tools -- S3 has
 * auto-scaled per-prefix request rates since 2018, so this has no
 * throughput rationale. See docs/architecture/dedup-and-object-storage.md.
 */
export function objectKey(hash: string): string {
  return `objects/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}
