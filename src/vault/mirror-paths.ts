import fs from "node:fs";
import path from "node:path";
import { objectKey, stateSnapshotKey, CURRENT_POINTER_KEY, VAULT_MANIFEST_KEY } from "./paths.js";
import type { RemoteConfig } from "./remote-config.js";

/**
 * The mirror location itself is wrong, in one of the ways this module
 * checks for: not configured, malformed, or configured but currently
 * unreachable (an unmounted drive, a dropped network share). Every
 * message names which.
 */
export class MirrorCheckError extends Error {}

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

/**
 * Throws unless the mirror at `config.mirror_path` both resolves and is
 * currently reachable on disk -- the precondition every `sync1 mirror`
 * subcommand needs, since none of them mean anything without a mirror
 * that is actually there right now.
 *
 * "Not configured" is itself a failure here, unlike
 * `resolveReachableMirrorIfConfigured` below: a caller reaching for this
 * variant is asking to *use* the mirror, not merely benefit from one if
 * present.
 */
export function requireReachableMirror(
  config: RemoteConfig,
  root: string,
  remoteConfigPath: string,
): string {
  const mirrorPath = resolveMirrorPath(config, root);
  if (mirrorPath === undefined) {
    throw new MirrorCheckError(
      `no mirror_path configured in "${remoteConfigPath}" -- add one to enable the mirror`,
    );
  }
  assertMirrorDirExists(mirrorPath);
  return mirrorPath;
}

/**
 * Resolves the mirror if one is configured and reachable, or `undefined`
 * if none is configured at all -- but **throws if one is configured and
 * cannot currently be reached**, rather than treating that the same as
 * "no mirror".
 *
 * This is the shape a caller that merely *benefits* from a mirror needs
 * (stubify's protective gate): no mirror configured, and a healthy
 * mirror, both mean "proceed normally". A mirror that is configured but
 * unreachable must never be silently read as "nothing is protected" --
 * that reads as "every file is safe to stub" when the true answer is "I
 * cannot tell". `mirrorObjectExists` alone cannot make this distinction
 * (an unmounted drive and a genuinely-absent object both throw `ENOENT`),
 * which is exactly the gap that let stubify skip every row with a
 * misleading reason while an unmounted mirror sat untouched.
 */
export function resolveReachableMirrorIfConfigured(
  config: RemoteConfig,
  root: string,
): string | undefined {
  const mirrorPath = resolveMirrorPath(config, root);
  if (mirrorPath === undefined) return undefined;
  assertMirrorDirExists(mirrorPath);
  return mirrorPath;
}

function assertMirrorDirExists(mirrorPath: string): void {
  if (!fs.existsSync(mirrorPath)) {
    throw new MirrorCheckError(
      `the configured mirror_path "${mirrorPath}" does not exist or is not reachable -- if it is a removable or network drive, mount it first`,
    );
  }
}
