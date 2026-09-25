import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";
import { parseManifest, unlockVault } from "../../src/vault/manifest.js";
import { parseRemoteConfig } from "../../src/vault/remote-config.js";
import Database from "better-sqlite3";
import {
  localVaultJsonPath,
  localRemoteConfigPath,
  localStateDbPath,
  localUploadInProgressMarkerPath,
} from "../../src/vault/local-dir.js";
import {
  objectKey,
  remoteKey,
  normalizePrefix,
  type RemoteLocation,
} from "../../src/vault/paths.js";
import { encryptBuffer } from "../../src/crypto/chunked-codec.js";
import { hashBufferHex } from "../../src/crypto/hash.js";

const PASSWORD = "correct horse battery staple";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-verify-remote-"));
}

/**
 * Reproduces exactly what a `sync` interrupted between its upload phase
 * and its own candidate being promoted leaves behind, without needing to
 * time a real process kill mid-upload: a correctly-encrypted object
 * genuinely present on S3 (built with the vault's own masterKey/context,
 * the same way apply-local-changes.ts's real upload path would), that no
 * committed state.db anywhere has ever referenced -- plus the durable
 * `upload-in-progress` marker a real aborted run would have left. See
 * test/e2e/lock.test.ts for the real-SIGINT-mid-run version of this same
 * "was a run interrupted" question; this one targets the specific
 * object-already-on-S3 recovery behavior, which a real interrupt can't
 * reliably be timed to land on.
 */
describe("sync recovers from a prior aborted run's already-uploaded object", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("skips re-uploading (marker alone, no --verify-remote needed) and clears the marker on success", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();

    await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        root,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );

    const content = "recovered content a prior run already uploaded";
    const hash = hashBufferHex(Buffer.from(content));
    fs.writeFileSync(path.join(root, "recovered.jpg"), content);

    // Marks it dirty (state 'created') in cache.db, without ever touching
    // state.db or S3 -- exactly the local state a real interrupted sync's
    // own scan phase would have produced.
    const updateCache = await runCli(["update_cache", "--root", root, "--json"]);
    expect(updateCache.exitCode).toBe(0);

    // Manually PUT the object sync1's own upload path would have produced
    // -- same masterKey, same context (the plaintext hash's own bytes),
    // same convergent encryption -- so it's genuinely indistinguishable
    // from what a real interrupted upload would have left on S3.
    const manifest = parseManifest(fs.readFileSync(localVaultJsonPath(root)));
    const masterKey = unlockVault(manifest, PASSWORD);
    const remoteConfig = parseRemoteConfig(fs.readFileSync(localRemoteConfigPath(root)));
    const location: RemoteLocation = {
      bucket: remoteConfig.bucket,
      prefix: normalizePrefix(remoteConfig.prefix),
    };
    const context = Buffer.from(hash, "hex");
    const encrypted = encryptBuffer(Buffer.from(content), masterKey, context);
    const key = remoteKey(location, objectKey(hash));
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: encrypted,
        ChecksumAlgorithm: "CRC64NVME",
      }),
    );
    const before = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

    // The marker a real interrupted run's own upload phase would have
    // left -- this alone is what triggers verify-remote mode; --verify-
    // remote itself is a manual override, not exercised here.
    fs.writeFileSync(localUploadInProgressMarkerPath(root), new Date().toISOString());

    const sync1 = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(sync1.exitCode).toBe(0);
    const parsed = JSON.parse(sync1.stdout) as {
      ok: boolean;
      uploaded_objects: number;
      deduped_objects: number;
    };
    expect(parsed.ok).toBe(true);
    // The whole point: recorded via the HEAD check, not a real upload.
    expect(parsed.uploaded_objects).toBe(0);
    expect(parsed.deduped_objects).toBe(1);

    // The object on S3 was never touched by this run -- LastModified is
    // still exactly what the manual PUT above set it to. If sync1 had
    // re-uploaded it, this would have advanced to the sync run's own time.
    const after = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    expect(after.LastModified?.getTime()).toBe(before.LastModified?.getTime());

    // Cleared on this run's own clean exit -- nothing left for a future
    // run to need recovery protection against.
    expect(fs.existsSync(localUploadInProgressMarkerPath(root))).toBe(false);

    // The recovered object's row carries the checksum S3 already had, not a
    // NULL. This is the only row this object will ever get: every later run
    // takes apply-local-changes.ts's `objectsRepo.has(hash)` shortcut, which
    // returns before the HEAD and never re-upserts -- so a NULL recorded
    // here is permanent, and silently costs this object the remote
    // content-audit that 0006_add_object_ciphertext_checksum.sql exists to
    // make possible. Asserted against what S3 itself reports, so a value
    // that's merely non-NULL but wrong fails too.
    const headWithChecksum = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }),
    );
    expect(headWithChecksum.ChecksumCRC64NVME).toEqual(expect.any(String));

    const stateDb = new Database(localStateDbPath(root), { readonly: true });
    const objectRow = stateDb
      .prepare("SELECT ciphertext_checksum FROM objects WHERE hash = ?")
      .get(hash) as { ciphertext_checksum: string | null } | undefined;
    stateDb.close();
    expect(objectRow?.ciphertext_checksum).toBe(headWithChecksum.ChecksumCRC64NVME);

    // And the path is genuinely, correctly tracked now: a follow-up
    // update_cache sees nothing left dirty.
    const followUp = await runCli(["update_cache", "--root", root, "--json"]);
    expect(followUp.exitCode).toBe(0);
    const followUpParsed = JSON.parse(followUp.stdout) as { created: number; unchanged: number };
    expect(followUpParsed.created).toBe(0);
    expect(followUpParsed.unchanged).toBe(1);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
