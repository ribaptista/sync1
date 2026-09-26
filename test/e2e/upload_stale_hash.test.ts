import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";

const PASSWORD = "correct horse battery staple";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-stale-"));
}

/**
 * The content-addressing invariant is that an object stored at key H
 * decrypts to content whose hash is H. Three shortcuts rest on it: local
 * dedup, the `verifyRemote` HEAD check, and the mirror's skip-if-exists.
 *
 * It is a write-time property that nothing used to enforce at write time.
 * `hash` and `size` come from the cache row that `update_cache` wrote; the
 * bytes are read from disk during the upload phase, which on a large vault
 * is hours later. A file edited in between would be encrypted under the
 * *old* hash's context and stored at the old hash's key.
 *
 * A size change is caught by the codec's `readExact`. The dangerous case is
 * a **size-preserving** edit: the byte count is right, so `ContentLength`
 * matches and the CRC64NVME both ends compute agree, and nothing in the
 * pipeline can tell. It would surface only on a much later `materialize` --
 * which does verify decrypted content against the recorded hash -- quite
 * possibly after `stubify` had removed the last local copy on the strength
 * of that upload.
 *
 * No test seam is needed to reach the window: `update_cache` and `sync` are
 * separate invocations, and restoring the mtime after the edit is exactly
 * what makes `sync`'s own re-scan keep the stale hash.
 */
describe("upload with a stale hash", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("refuses to store content under a hash it no longer matches, and leaves nothing in the bucket", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();
    const filePath = path.join(root, "edited-mid-sync.txt");

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

    const scanned = "the content that was hashed at scan time..";
    const edited = "the content that is on disk at upload time";
    expect(edited.length).toBe(scanned.length); // the whole point

    fs.writeFileSync(filePath, scanned);
    const cached = await runCli(["update_cache", "--root", root, "--json"]);
    expect(cached.exitCode).toBe(0);

    // Edit the bytes, then put the timestamp back. sync's own scanning
    // phase re-runs update_cache, and its mtime+size fast path will now see
    // "unchanged" and keep the hash taken from the *old* content -- which
    // is precisely the state this test exists to reach.
    const { atime, mtime } = fs.statSync(filePath);
    fs.writeFileSync(filePath, edited);
    fs.utimesSync(filePath, atime, mtime);

    const startedAt = Date.now();
    const synced = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    const elapsed = Date.now() - startedAt;

    // The upload is abandoned, so nothing is committed.
    const summary = JSON.parse(synced.stdout) as {
      uploaded_objects: number;
      local_entries_changed: number;
    };
    expect(summary.uploaded_objects).toBe(0);
    expect(summary.local_entries_changed).toBe(0);

    // The strong assertion: the object must never have existed, not have
    // been created and then cleaned up. A compensating delete would leave a
    // window for another machine's verifyRemote HEAD to adopt bad content,
    // so "404 afterwards" is necessary but not sufficient -- no content
    // object at all is what the aborted stream guarantees.
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "objects/" }));
    expect(listed.KeyCount ?? 0).toBe(0);

    // Guards a regression that is invisible to every other assertion here.
    // Rejecting the caller's promise is only half the job: the SDK request
    // keeps waiting on a body that will never produce another byte, and
    // Node will not exit until its socket times out -- roughly a minute per
    // failed object, long after the failure was logged. The abort signal in
    // putObjectStream collapses that to immediate. The bound is deliberately
    // loose (a healthy run here is ~1s) so this fails on a 60s hang, never
    // on a slow machine. The e2e project sets no test timeout, so without
    // this the hang would merely make the suite crawl.
    expect(elapsed).toBeLessThan(25_000);

    // And the row is still pending, so a later sync retries it honestly
    // once the cache has caught up with the real content.
    const pending = await runCli(["diff", "--root", root, "--json"]);
    expect(pending.stdout).toContain("edited-mid-sync.txt");

    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * The same guarantee above the multipart threshold, where `lib-storage`'s
   * `Upload` rather than a single `PutObjectCommand` is in play: an errored
   * body must abort the multipart upload instead of completing it, and must
   * not leave parts behind that S3 would keep billing for.
   */
  it("aborts rather than completing a multipart upload, leaving no stray parts", async () => {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();
    const filePath = path.join(root, "big-edited.bin");

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

    // Comfortably over MULTIPART_THRESHOLD_BYTES (32 MiB).
    const size = 40 * 1024 * 1024;
    fs.writeFileSync(filePath, Buffer.alloc(size, 0x41));
    const cached = await runCli(["update_cache", "--root", root, "--json"]);
    expect(cached.exitCode).toBe(0);

    const { atime, mtime } = fs.statSync(filePath);
    fs.writeFileSync(filePath, Buffer.alloc(size, 0x42));
    fs.utimesSync(filePath, atime, mtime);

    const synced = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect((JSON.parse(synced.stdout) as { uploaded_objects: number }).uploaded_objects).toBe(0);

    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "objects/" }));
    expect(listed.KeyCount ?? 0).toBe(0);

    fs.rmSync(root, { recursive: true, force: true });
  }, 180_000);

  /**
   * The counterpart: an ordinary sync of unmodified content must be
   * completely unaffected. Without this, a check that rejected everything
   * would pass the two tests above.
   */
  it("uploads normally when the content still matches its hash", async () => {
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
    fs.writeFileSync(path.join(root, "honest.txt"), "content nobody touched");
    await runCli(["update_cache", "--root", root, "--json"]);

    const synced = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(synced.exitCode).toBe(0);
    expect((JSON.parse(synced.stdout) as { uploaded_objects: number }).uploaded_objects).toBe(1);

    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "objects/" }));
    expect(listed.KeyCount ?? 0).toBe(1);
    const key = listed.Contents![0]!.Key!;
    await expect(
      s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
    ).resolves.toBeTruthy();

    fs.rmSync(root, { recursive: true, force: true });
  });
});
