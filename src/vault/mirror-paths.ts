import path from "node:path";
import { objectKey, stateSnapshotKey, CURRENT_POINTER_KEY, VAULT_MANIFEST_KEY } from "./paths.js";
import type { RemoteConfig } from "./remote-config.js";

/**
 * Where a mirror's files live, derived from the *same* key functions the
 * bucket uses (`objectKey`, `stateSnapshotKey`, and the two manifest
 * constants in paths.ts) rather than a parallel scheme.
 *
 * That is deliberate and load-bearing, not tidiness. A mirror whose layout
 * matches the bucket byte-for-byte can be served straight back with
 * `rclone serve s3` or MinIO and attached with the existing
 * `attach_remote --endpoint`, so a restore needs no translation layer and
 * no sync1-specific tooling. A bespoke layout would turn the drive into
 * something only this program could read, which is the opposite of what a
 * disaster-recovery copy is for.
 *
 * Note the vault prefix is deliberately *not* applied: `remoteKey()` adds
 * it inside the bucket so several vaults can share one, whereas a mirror
 * directory is already the vault's own. Its contents therefore correspond
 * to `<bucket>/<prefix>/`, not to the bucket root.
 */
export function mirrorObjectPath(mirrorPath: string, hash: string): string {
  return path.join(mirrorPath, ...objectKey(hash).split("/"));
}

export function mirrorStateSnapshotPath(mirrorPath: string, versionStamp: string): string {
  return path.join(mirrorPath, ...stateSnapshotKey(versionStamp).split("/"));
}

export function mirrorCurrentPointerPath(mirrorPath: string): string {
  return path.join(mirrorPath, CURRENT_POINTER_KEY);
}

export function mirrorVaultManifestPath(mirrorPath: string): string {
  return path.join(mirrorPath, VAULT_MANIFEST_KEY);
}

/**
 * The configured mirror path as an absolute path, or `undefined` when no
 * mirror is configured.
 *
 * Validated here rather than in `parseRemoteConfig` because the one check
 * worth making needs the vault root: **a mirror inside the tracked tree
 * would back itself up.** Every object written to it would be walked as
 * ordinary content on the next `update_cache`, hashed, encrypted and
 * uploaded -- growing without bound, one generation per sync. Relative
 * paths are rejected outright rather than resolved against the process's
 * cwd, which would silently mean different directories for the same
 * config depending on where the command was run from.
 */
export function resolveMirrorPath(config: RemoteConfig, root: string): string | undefined {
  const configured = config.mirror_path;
  if (configured === undefined || configured === "") return undefined;

  if (!path.isAbsolute(configured)) {
    throw new Error(
      `mirror_path "${configured}" must be an absolute path -- a relative one would resolve differently depending on the directory a command happened to be run from`,
    );
  }

  const resolvedMirror = path.resolve(configured);
  const resolvedRoot = path.resolve(root);
  const relativeToRoot = path.relative(resolvedRoot, resolvedMirror);
  const insideRoot =
    relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot));
  if (insideRoot) {
    throw new Error(
      `mirror_path "${resolvedMirror}" is inside the vault root "${resolvedRoot}" -- the mirror would be walked as ordinary content and back itself up, one generation per sync`,
    );
  }

  return resolvedMirror;
}
