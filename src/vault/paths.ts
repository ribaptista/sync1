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

export function objectKey(hash: string): string {
  return `objects/${hash}`;
}
