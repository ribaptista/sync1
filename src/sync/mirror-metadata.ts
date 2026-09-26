import fs from "node:fs";
import type { Logger } from "../logger.js";
import { writeMirrorFile, MirrorWriteError } from "../fs/mirror-sink.js";
import {
  mirrorStateSnapshotPath,
  mirrorCurrentPointerPath,
  mirrorVaultManifestPath,
  resolveMirrorPath,
} from "../vault/mirror-paths.js";
import { localVaultJsonPath, localRemoteConfigPath } from "../vault/local-dir.js";
import { parseRemoteConfig } from "../vault/remote-config.js";

/**
 * Mirroring of the three small keys that are not content objects:
 * `states/<stamp>`, `current`, and `vault.json`.
 *
 * Two rules govern all of it.
 *
 * **Order.** `commit-pointer.ts` states the invariant for S3: objects and
 * snapshots are idempotent, `current` is not. The mirror follows the same
 * sequence -- objects, then the snapshot, then the pointer -- and moves its
 * pointer only *after* S3's CAS has succeeded, so the mirror can never name
 * a version S3 has not committed.
 *
 * **Never fatal.** Unlike a content object, these failures do not fail a
 * commit. By the time they run, S3 has already accepted the snapshot and
 * (for the pointer) the CAS is done; the vault is committed whatever
 * happens next locally. Throwing here would turn a successful sync into a
 * failed one over a detached drive, and would do it *after* the point of no
 * return, leaving the caller nothing useful to retry. The gap is a warning
 * and `mirror catchup`'s job -- which, for metadata, simply re-fetches from
 * S3.
 */
export async function mirrorStateSnapshot(
  mirrorPath: string | undefined,
  versionStamp: string,
  encryptedSnapshot: Buffer,
  logger: Logger,
): Promise<void> {
  if (mirrorPath === undefined) return;
  await mirrorQuietly(logger, "state.db snapshot", { versionStamp }, () =>
    writeMirrorFile(mirrorStateSnapshotPath(mirrorPath, versionStamp), encryptedSnapshot),
  );
}

/**
 * Also copies `vault.json` when the mirror lacks it. Without those 363
 * bytes -- the Argon2id salt and verifier -- the mirror is undecryptable
 * even with the right password, so a mirror that has content objects but no
 * manifest is not a backup at all. Copied on demand rather than at
 * configuration time because nothing hooks the moment a `mirror_path` is
 * added to remote.json by hand.
 */
export async function mirrorCurrentPointer(
  mirrorPath: string | undefined,
  root: string,
  versionStamp: string,
  logger: Logger,
): Promise<void> {
  if (mirrorPath === undefined) return;

  const manifestTarget = mirrorVaultManifestPath(mirrorPath);
  if (!fs.existsSync(manifestTarget)) {
    await mirrorQuietly(logger, "vault.json", {}, () =>
      writeMirrorFile(manifestTarget, fs.readFileSync(localVaultJsonPath(root))),
    );
  }

  await mirrorQuietly(logger, "current pointer", { versionStamp }, () =>
    writeMirrorFile(mirrorCurrentPointerPath(mirrorPath), Buffer.from(versionStamp, "utf8")),
  );
}

async function mirrorQuietly(
  logger: Logger,
  what: string,
  context: Record<string, unknown>,
  write: () => Promise<void>,
): Promise<void> {
  try {
    await write();
    logger.debug({ ...context, what }, "mirrored");
  } catch (err) {
    const cause = err instanceof MirrorWriteError ? err.cause : err;
    logger.warn(
      { ...context, what, err: cause instanceof Error ? cause.message : String(cause) },
      "could not mirror -- the commit itself succeeded; run `sync1 mirror catchup` to close the gap",
    );
  }
}

/**
 * The configured mirror, or `undefined` -- never throwing. A malformed
 * `mirror_path` must not turn an otherwise-valid state change into a
 * failure; `sync` and the `mirror` commands surface that properly, with
 * room to explain it.
 *
 * Shared by the **three** paths that commit a version -- `commit.ts`,
 * `mutateStateDb` (policy edits) and `gc` -- and resolved here rather than
 * passed in, so a fourth cannot quietly skip the mirror by forgetting a
 * parameter. Missing one is not a small gap: `verify` judges completeness
 * against the mirror's *own* snapshot, so a stale snapshot keeps vouching
 * for a drive that is drifting further behind with every commit it never
 * saw.
 */
export function mirrorPathFor(root: string, logger: Logger): string | undefined {
  try {
    return resolveMirrorPath(parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root))), root);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "ignoring an unusable mirror_path for this state change",
    );
    return undefined;
  }
}
