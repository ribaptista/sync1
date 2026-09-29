import fs from "node:fs";
import path from "node:path";
import type { Command, OptionValues } from "commander";
import { createLoggerForRun, shouldShowProgress } from "../cli/progress.js";
import { emitJson, emitError, exitCodeForError, EXIT_GENERIC_ERROR } from "../cli/output.js";
import { resolveRoot } from "../cli/resolve-root.js";
import {
  localRemoteConfigPath,
  localVaultJsonPath,
  lastSyncedVersionPath,
  localStateDbPath,
} from "../vault/local-dir.js";
import { parseRemoteConfig } from "../vault/remote-config.js";
import {
  createS3Client,
  getObject,
  getObjectStream,
  headObject,
  restoreObject,
} from "../s3/client.js";
import { classifyArchiveStatus } from "../s3/archive-status.js";
import {
  remoteKey,
  normalizePrefix,
  CURRENT_POINTER_KEY,
  stateSnapshotKey,
} from "../vault/paths.js";
import type { RemoteLocation } from "../vault/paths.js";
import { getPassword } from "../cli/password.js";
import { parseManifest, unlockVault } from "../vault/manifest.js";
import { decryptBuffer } from "../crypto/chunked-codec.js";
import { openStateDbReadOnly, openCacheDbReadOnly } from "../db/connection.js";
import { ObjectsRepository } from "../db/repositories/objects-repository.js";
import { EntriesRepository } from "../db/repositories/entries-repository.js";
import { CacheEntriesRepository } from "../db/repositories/cache-entries-repository.js";
import { tempSiblingPath } from "../fs/temp-path.js";
import { writeMirrorFile } from "../fs/mirror-sink.js";
import {
  assertMirrorVaultMatches,
  readMirrorVersion,
  verifyMirrorObjects,
  findExtraMirrorObjects,
  walkMirrorTemps,
  writeVerifiedMirrorObject,
  downloadObjectToMirror,
  type MirrorVerifyDepth,
} from "../fs/mirror-ops.js";
import {
  mirrorObjectPath,
  mirrorStateSnapshotPath,
  mirrorCurrentPointerPath,
  mirrorVaultManifestPath,
  requireReachableMirror,
  MirrorCheckError,
} from "../vault/mirror-paths.js";
import { mirrorObjectExists } from "../fs/mirror-sink.js";
import { encryptedSize } from "../crypto/streaming-codec.js";
import { HASH_BYTES } from "../crypto/hash.js";
import type { Logger } from "../logger.js";

/**
 * Matched to `materialize`'s own values, deliberately: a restore requested
 * by one command and consumed by the other should last the same length of
 * time, and Standard tier is the sane default for a backup nobody is
 * waiting on in real time.
 */
const RESTORE_DAYS = 7;
const RESTORE_TIER = "Standard" as const;

interface MirrorOptions extends OptionValues {
  root?: string;
  quick?: boolean;
  checksum?: boolean;
  offline?: boolean;
  allowDownload?: boolean;
  requestRetrieval?: boolean;
  apply?: boolean;
}

interface GlobalOptions extends OptionValues {
  json?: boolean;
  verbose?: boolean;
  progress?: boolean;
}

/**
 * The mirror's own view of itself.
 *
 * Every command here resolves the mirror before doing anything else, and
 * refuses rather than reporting a comforting zero when there is nothing to
 * look at -- "0 problems found" and "I could not reach the drive" must
 * never be the same output.
 */
function resolveMirror(root: string): {
  mirrorPath: string;
  remoteConfig: ReturnType<typeof parseRemoteConfig>;
} {
  const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
  const mirrorPath = requireReachableMirror(remoteConfig, root, localRemoteConfigPath(root));
  return { mirrorPath, remoteConfig };
}

/**
 * Decrypts one of the mirror's own snapshots into a temporary database.
 *
 * Deliberately the mirror's snapshot rather than the local `state.db`:
 * object completeness is judged against what the drive itself claims to
 * hold, so a mirror that is merely *behind* reads as behind, not as
 * massively corrupt.
 */
function openMirrorSnapshot(
  mirrorPath: string,
  root: string,
  versionStamp: string,
  masterKey: Buffer,
): { db: import("better-sqlite3").Database; cleanup: () => void } {
  const encrypted = fs.readFileSync(mirrorStateSnapshotPath(mirrorPath, versionStamp));
  const plaintext = decryptBuffer(encrypted, masterKey);
  const tempPath = tempSiblingPath(localStateDbPath(root), "mirror-snapshot");
  fs.writeFileSync(tempPath, plaintext);
  const db = openStateDbReadOnly(tempPath);
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(tempPath, { force: true });
    },
  };
}

async function referenceVersionFor(
  opts: MirrorOptions,
  root: string,
  remoteConfig: ReturnType<typeof parseRemoteConfig>,
): Promise<{ version: string | null; reference: "s3" | "local" }> {
  // Default to S3 because that is the authoritative answer. Comparing
  // against the local `last_synced_version` instead measures the mirror
  // against this machine's possibly-stale idea of the vault -- which is
  // weak assurance from a command whose entire job is assurance. It stays
  // available, but as an explicit choice that the output names.
  if (opts.offline) {
    const localVersion = fs.readFileSync(lastSyncedVersionPath(root), "utf8").trim();
    return { version: localVersion || null, reference: "local" };
  }

  const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
  const location: RemoteLocation = {
    bucket: remoteConfig.bucket,
    prefix: normalizePrefix(remoteConfig.prefix),
  };
  const current = await getObject(
    client,
    remoteConfig.bucket,
    remoteKey(location, CURRENT_POINTER_KEY),
  );
  if (!current) {
    throw new MirrorCheckError("the vault has no /current pointer in S3 (corrupt vault?)");
  }
  return { version: current.body.toString("utf8").trim(), reference: "s3" };
}

async function runVerify(
  opts: MirrorOptions,
  logger: Logger,
): Promise<{ stats: Record<string, unknown>; ok: boolean }> {
  const root = resolveRoot(opts.root);
  const { mirrorPath, remoteConfig } = resolveMirror(root);

  assertMirrorVaultMatches(mirrorPath, root);
  const mirrorVersion = readMirrorVersion(mirrorPath);
  const { version: referenceVersion, reference } = await referenceVersionFor(
    opts,
    root,
    remoteConfig,
  );
  const upToDate = referenceVersion !== null && referenceVersion === mirrorVersion;

  const staleTemps = countOf(walkMirrorTemps(mirrorPath));

  if (opts.quick) {
    return {
      stats: {
        mirror_version: mirrorVersion,
        reference_version: referenceVersion,
        reference,
        up_to_date: upToDate,
        stale_temps: staleTemps,
        depth: "quick",
      },
      // A behind mirror is a fact, not a failure -- it is exactly what
      // `catchup` exists for, and reporting it as broken would make the
      // one command you run on a schedule cry wolf.
      ok: staleTemps === 0,
    };
  }

  const password = await getPassword();
  const manifest = parseManifest(fs.readFileSync(localVaultJsonPath(root)));
  const masterKey = unlockVault(manifest, password);
  const snapshot = openMirrorSnapshot(mirrorPath, root, mirrorVersion, masterKey);

  try {
    const depth: MirrorVerifyDepth = opts.checksum ? "checksum" : "presence";
    const objectStats = await verifyMirrorObjects(mirrorPath, snapshot.db, depth, logger);
    const extra = countOf(findExtraMirrorObjects(mirrorPath, snapshot.db));

    const damaged = objectStats.missing + objectStats.wrongSize + objectStats.checksumMismatch;
    return {
      stats: {
        mirror_version: mirrorVersion,
        reference_version: referenceVersion,
        reference,
        up_to_date: upToDate,
        depth,
        objects_checked: objectStats.objectsChecked,
        missing: objectStats.missing,
        wrong_size: objectStats.wrongSize,
        checksum_mismatch: objectStats.checksumMismatch,
        extra,
        stale_temps: staleTemps,
      },
      // `extra` is deliberately not a failure: gc's scope is the current
      // live state, so objects it removed from S3 legitimately survive
      // here. That is the mirror's value as a safety net, and `prune` is
      // the separate opt-in for reclaiming the space.
      ok: damaged === 0,
    };
  } finally {
    snapshot.cleanup();
  }
}

async function runCatchup(
  opts: MirrorOptions,
  logger: Logger,
): Promise<{ stats: Record<string, unknown>; ok: boolean }> {
  const root = resolveRoot(opts.root);
  const { mirrorPath, remoteConfig } = resolveMirror(root);

  const client = createS3Client({ endpoint: remoteConfig.endpoint, region: remoteConfig.region });
  const location: RemoteLocation = {
    bucket: remoteConfig.bucket,
    prefix: normalizePrefix(remoteConfig.prefix),
  };

  // Metadata comes straight from S3, unconditionally and without
  // --allow-download. A snapshot is megabytes where the objects are
  // hundreds of gigabytes, so the egress this whole feature exists to
  // avoid simply is not at stake -- and paying the same parsimony here
  // would buy nothing while leaving the mirror unreadable.
  let metadataFetched = 0;
  const currentObject = await getObject(
    client,
    remoteConfig.bucket,
    remoteKey(location, CURRENT_POINTER_KEY),
  );
  if (!currentObject) throw new MirrorCheckError("the vault has no /current pointer in S3");
  const versionStamp = currentObject.body.toString("utf8").trim();

  if (!fs.existsSync(mirrorVaultManifestPath(mirrorPath))) {
    await writeMirrorFile(
      mirrorVaultManifestPath(mirrorPath),
      fs.readFileSync(localVaultJsonPath(root)),
    );
    metadataFetched++;
  }

  if (!fs.existsSync(mirrorStateSnapshotPath(mirrorPath, versionStamp))) {
    const snapshot = await getObject(
      client,
      remoteConfig.bucket,
      remoteKey(location, stateSnapshotKey(versionStamp)),
    );
    if (!snapshot) {
      throw new MirrorCheckError(
        `S3's current pointer names ${versionStamp}, but states/${versionStamp} is not there (corrupt vault?)`,
      );
    }
    await writeMirrorFile(mirrorStateSnapshotPath(mirrorPath, versionStamp), snapshot.body);
    metadataFetched++;
  }

  // Deliberately NOT backfilling older snapshots. `gc` removes objects not
  // referenced by the *current* live state, so an object referenced only
  // by an old snapshot is already gone from S3 -- historical snapshots are
  // partially dangling there too. Fetching them would import a
  // completeness target nobody can ever meet.

  const password = await getPassword();
  const manifest = parseManifest(fs.readFileSync(localVaultJsonPath(root)));
  const masterKey = unlockVault(manifest, password);

  // openMirrorSnapshot reads the state.db snapshot file this run just wrote
  // to the mirror above -- it does not depend on the mirror's own `current`
  // pointer, which is deliberately NOT written yet. Writing it here, before
  // the object-recovery loop below has actually run, is what used to let an
  // interrupted or partial catchup leave the mirror's pointer naming a
  // version whose objects aren't all there -- `mirror verify --quick`
  // (pointer + snapshot presence only, no object sweep) would then report
  // `up_to_date: true` on a mirror that couldn't actually restore anything
  // materialized-but-not-locally-recoverable. The pointer is written last,
  // below, and only once every object this run knows about was either
  // already present, recovered, or downloaded.
  const snapshot = openMirrorSnapshot(mirrorPath, root, versionStamp, masterKey);
  const cacheDb = openCacheDbReadOnly(path.join(root, ".sync1", "cache.db"));

  let recovered = 0;
  let alreadyPresent = 0;
  let unrecoverableLocally = 0;
  let downloaded = 0;
  let restoreRequested = 0;
  let restorePending = 0;
  let archivedNotRequested = 0;

  try {
    const objectsRepo = new ObjectsRepository(snapshot.db);
    const entriesRepo = new EntriesRepository(snapshot.db);
    const cacheRepo = new CacheEntriesRepository(cacheDb);

    for (const row of objectsRepo.iterateAll()) {
      const target = mirrorObjectPath(mirrorPath, row.hash);
      if (mirrorObjectExists(target, encryptedSize(row.size, HASH_BYTES))) {
        alreadyPresent++;
        continue;
      }

      if (await recoverFromLocalSources(mirrorPath, row, root, cacheRepo, entriesRepo, masterKey)) {
        recovered++;
        logger.debug({ hash: row.hash }, "object recovered from local plaintext");
        continue;
      }

      // No local source: S3 is the only remaining option, and the only
      // step that costs egress -- hence the explicit flag rather than a
      // silent fallback that would reintroduce the cost this whole
      // feature exists to avoid.
      if (!opts.allowDownload) {
        unrecoverableLocally++;
        logger.warn(
          { hash: row.hash },
          "object has no usable local source -- every path referencing it is missing, stubbed, or edited; pass --allow-download to fetch it from S3",
        );
        continue;
      }

      const key = remoteKey(location, row.s3_key);
      const head = await headObject(client, remoteConfig.bucket, key);
      if (!head) {
        unrecoverableLocally++;
        logger.warn({ hash: row.hash }, "object has no local source and is missing in S3 too");
        continue;
      }

      const status = classifyArchiveStatus(head);
      if (status === "immediate" || status === "restore-ready") {
        const stream = await getObjectStream(client, remoteConfig.bucket, key);
        if (!stream || !(await downloadObjectToMirror(mirrorPath, row, stream.body))) {
          unrecoverableLocally++;
          logger.warn(
            { hash: row.hash },
            "downloaded object did not match its recorded checksum -- discarded rather than mirrored",
          );
          continue;
        }
        downloaded++;
        logger.debug({ hash: row.hash }, "object downloaded from S3 to the mirror");
        continue;
      }

      // Archived. Reuses materialize's own four-state flow rather than
      // inventing one: a restore takes hours on Glacier and up to two days
      // on Deep Archive, so the honest answer is to request it (when asked
      // to) and have the user run this again later.
      if (status === "restore-ongoing") {
        restorePending++;
        logger.debug({ hash: row.hash }, "a restore is already in flight for this object");
        continue;
      }

      if (opts.requestRetrieval) {
        await restoreObject(client, remoteConfig.bucket, key, {
          days: RESTORE_DAYS,
          tier: RESTORE_TIER,
        });
        restoreRequested++;
        logger.debug({ hash: row.hash }, "requested a temporary restore");
      } else {
        archivedNotRequested++;
        logger.warn(
          { hash: row.hash, status },
          "object is archived and no restore has been requested -- pass --request-retrieval to start one",
        );
      }
    }

    // The pointer is what `readMirrorVersion` (used by `mirror verify`/
    // `mirror prune`) trusts as "which version does this mirror currently
    // claim to hold" -- writing it here, only now that every object this
    // run knows about has been accounted for, is what keeps that claim
    // honest. Gated on the same condition as `ok` below: an unrecoverable
    // object means this version's object set is genuinely incomplete on
    // the mirror, so the pointer must not move to it yet. A restore still
    // pending, or an archived object whose retrieval was never requested,
    // does not block it -- consistent with `ok`'s own "come back later,
    // not a failure" reading of those two states.
    if (unrecoverableLocally === 0) {
      await writeMirrorFile(
        mirrorCurrentPointerPath(mirrorPath),
        Buffer.from(versionStamp, "utf8"),
      );
    } else {
      logger.debug(
        { versionStamp, unrecoverableLocally },
        "leaving the mirror's current pointer unmoved -- at least one object this run knows about has no usable source; run again with --allow-download, or supply the content locally",
      );
    }

    return {
      stats: {
        version_stamp: versionStamp,
        metadata_fetched: metadataFetched,
        already_present: alreadyPresent,
        recovered,
        downloaded,
        restore_requested: restoreRequested,
        restore_pending: restorePending,
        archived_not_requested: archivedNotRequested,
        unrecoverable_locally: unrecoverableLocally,
      },
      // A pending or unrequested restore is "come back later", not a
      // failure -- the same reading materialize gives it. Only an object
      // nothing can supply makes the run non-ok.
      ok: unrecoverableLocally === 0,
    };
  } finally {
    snapshot.cleanup();
    cacheDb.close();
  }
}

/**
 * Tries every path that references this object, not merely the first.
 *
 * In a deduped vault several paths share one object, and one may still
 * hold the original bytes while another was edited -- so giving up after
 * the first miss would forfeit recoveries that are right there. Cheap,
 * because the expensive check only runs on paths that pass the cheap ones.
 */
async function recoverFromLocalSources(
  mirrorPath: string,
  row: { hash: string; size: number; s3_key: string; ciphertext_checksum: string },
  root: string,
  cacheRepo: CacheEntriesRepository,
  entriesRepo: EntriesRepository,
  masterKey: Buffer,
): Promise<boolean> {
  for (const entry of entriesRepo.iterateByHash(row.hash)) {
    const cacheRow = cacheRepo.get(entry.path);
    // A `modified`/`created` row is a near-certain mismatch; reading
    // gigabytes to confirm that would be the most expensive way possible
    // to learn nothing. The authoritative check still runs on the rows
    // that pass, because an mtime-clean row can still be wrong -- the same
    // trust boundary `stubify` draws before it deletes anything.
    if (cacheRow === undefined || cacheRow.state !== "unchanged") continue;

    const absolutePath = path.join(root, entry.path);
    // A stub exists on disk but its bytes are the stub, not the content.
    if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).size !== row.size) continue;

    if (await writeVerifiedMirrorObject(mirrorPath, row, absolutePath, masterKey)) return true;
  }
  return false;
}

async function runPrune(
  opts: MirrorOptions,
  logger: Logger,
): Promise<{ stats: Record<string, unknown>; ok: boolean }> {
  const root = resolveRoot(opts.root);
  const { mirrorPath } = resolveMirror(root);

  assertMirrorVaultMatches(mirrorPath, root);
  const mirrorVersion = readMirrorVersion(mirrorPath);

  const password = await getPassword();
  const manifest = parseManifest(fs.readFileSync(localVaultJsonPath(root)));
  const masterKey = unlockVault(manifest, password);
  const snapshot = openMirrorSnapshot(mirrorPath, root, mirrorVersion, masterKey);

  try {
    let count = 0;
    let bytes = 0;
    for (const file of findExtraMirrorObjects(mirrorPath, snapshot.db)) {
      count++;
      bytes += file.size;
      if (opts.apply) {
        fs.rmSync(file.absolutePath, { force: true });
        logger.debug({ hash: file.hash }, "pruned from the mirror");
      }
    }
    return {
      stats: {
        mirror_version: mirrorVersion,
        applied: opts.apply ?? false,
        pruned: count,
        reclaimed_bytes: bytes,
      },
      ok: true,
    };
  } finally {
    snapshot.cleanup();
  }
}

function countOf<T>(items: Iterable<T>): number {
  let n = 0;
  for (const _item of items) n++;
  return n;
}

export function registerMirrorCommand(program: Command): void {
  const mirror = program
    .command("mirror")
    .description("Inspect and repair the optional local mirror of the encrypted vault");

  const withCommon = (cmd: Command): Command =>
    cmd.option(
      "--root <path>",
      "local directory whose vault to act on (defaults to the nearest ancestor directory with a .sync1/)",
    );

  withCommon(
    mirror
      .command("verify")
      .description("Check that the mirror is, by itself, a complete and restorable copy")
      .option("--quick", "pointer and snapshot presence only -- no password, no object sweep")
      .option(
        "--checksum",
        "also hash every stored object against its recorded checksum (reads the whole mirror)",
      )
      .option(
        "--offline",
        "compare against this machine's last_synced_version instead of S3's current pointer, accepting that it may be stale",
      ),
  ).action(async (opts: MirrorOptions, command: Command) => {
    await runSubcommand("mirror_verify", opts, command, runVerify, summarizeVerify);
  });

  withCommon(
    mirror
      .command("catchup")
      .description("Write whatever the mirror is missing, preferring local plaintext over S3")
      .option(
        "--allow-download",
        "permit fetching object content from S3 when no local source can supply it (costs egress)",
      )
      .option(
        "--request-retrieval",
        "with --allow-download, request a temporary restore for archived (GLACIER/DEEP_ARCHIVE) objects, which costs retrieval fees and takes hours to days",
      ),
  ).action(async (opts: MirrorOptions, command: Command) => {
    await runSubcommand("mirror_catchup", opts, command, runCatchup, summarizeCatchup);
  });

  withCommon(
    mirror
      .command("prune")
      .description("Remove mirror objects the current snapshot no longer references")
      .option("--apply", "actually delete them; without it, only counts what would be removed"),
  ).action(async (opts: MirrorOptions, command: Command) => {
    await runSubcommand("mirror_prune", opts, command, runPrune, summarizePrune);
  });
}

async function runSubcommand(
  name: string,
  opts: MirrorOptions,
  command: Command,
  run: (
    opts: MirrorOptions,
    logger: Logger,
  ) => Promise<{ stats: Record<string, unknown>; ok: boolean }>,
  summarize: (stats: Record<string, unknown>) => string,
): Promise<void> {
  const globalOpts = command.optsWithGlobals<GlobalOptions>();
  const json = globalOpts.json ?? false;
  const showProgress = shouldShowProgress({ json, progress: globalOpts.progress ?? true });
  const logger = createLoggerForRun({
    verbose: globalOpts.verbose ?? false,
    showProgress,
  }).child({ command: name });

  try {
    const { stats, ok } = await run(opts, logger);
    if (json) emitJson({ ok, ...stats });
    else process.stdout.write(summarize(stats));
    if (!ok) process.exitCode = EXIT_GENERIC_ERROR;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug({ err: message }, `${name} failed`);
    emitError(json, message, exitCodeForError(err));
  }
}

function summarizeVerify(stats: Record<string, unknown>): string {
  const lag = stats.up_to_date
    ? "up to date"
    : `behind ${String(stats.reference)} (mirror ${String(stats.mirror_version)}, ${String(stats.reference)} ${String(stats.reference_version)})`;
  if (stats.depth === "quick") {
    return `mirror verify (quick): ${lag}, ${String(stats.stale_temps)} stale temp(s)\n`;
  }
  return (
    `mirror verify (${String(stats.depth)}): ${lag}\n` +
    `  ${String(stats.objects_checked)} object(s) checked -- ` +
    `${String(stats.missing)} missing, ${String(stats.wrong_size)} wrong size, ` +
    `${String(stats.checksum_mismatch)} checksum mismatch\n` +
    `  ${String(stats.extra)} extra (not referenced by this snapshot), ` +
    `${String(stats.stale_temps)} stale temp(s)\n`
  );
}

function summarizeCatchup(stats: Record<string, unknown>): string {
  let out =
    `mirror catchup: version ${String(stats.version_stamp)} -- ` +
    `${String(stats.metadata_fetched)} metadata file(s) fetched, ` +
    `${String(stats.recovered)} recovered locally, ` +
    `${String(stats.downloaded)} downloaded, ` +
    `${String(stats.already_present)} already present, ` +
    `${String(stats.unrecoverable_locally)} with no usable source\n`;
  const archived =
    Number(stats.restore_requested) +
    Number(stats.restore_pending) +
    Number(stats.archived_not_requested);
  if (archived > 0) {
    out +=
      `  archived: ${String(stats.restore_requested)} restore(s) requested, ` +
      `${String(stats.restore_pending)} already in flight, ` +
      `${String(stats.archived_not_requested)} not requested -- ` +
      `run this again once they are ready\n`;
  }
  return out;
}

function summarizePrune(stats: Record<string, unknown>): string {
  const mode = stats.applied ? "removed" : "would remove";
  return `mirror prune: ${mode} ${String(stats.pruned)} object(s), ${String(stats.reclaimed_bytes)} bytes\n`;
}
