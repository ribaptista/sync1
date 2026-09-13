import path from "node:path";

export function sync1Dir(root: string): string {
  return path.join(root, ".sync1");
}

export function localStateDbPath(root: string): string {
  return path.join(sync1Dir(root), "state.db");
}

export function localCacheDbPath(root: string): string {
  return path.join(sync1Dir(root), "cache.db");
}

export function lastSyncedVersionPath(root: string): string {
  return path.join(sync1Dir(root), "last_synced_version");
}

export function localVaultJsonPath(root: string): string {
  return path.join(sync1Dir(root), "vault.json");
}

export function localRemoteConfigPath(root: string): string {
  return path.join(sync1Dir(root), "remote.json");
}

export function localLockPath(root: string): string {
  return path.join(sync1Dir(root), "lock");
}
