import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import crypto from "node:crypto";
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
import { MULTIPART_THRESHOLD_BYTES } from "../../src/s3/client.js";
import { hashBufferHex } from "../../src/crypto/hash.js";

const PASSWORD = "correct horse battery staple";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-multipart-"));
}

describe("multipart upload for an object over the size threshold", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("uploads via real multipart (not a single PUT) and round-trips byte-for-byte", async () => {
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

    // Plaintext size comfortably above MULTIPART_THRESHOLD_BYTES -- the
    // encrypted size (slightly larger, fixed per-chunk AEAD overhead) stays
    // well above the threshold too, so this exercises the real multipart
    // path end-to-end, not a real 100GB fixture.
    const size = MULTIPART_THRESHOLD_BYTES + 1024 * 1024;
    const content = crypto.randomBytes(size);
    fs.writeFileSync(path.join(root, "large.bin"), content);
    const expectedHash = hashBufferHex(content);

    const syncResult = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(syncResult.exitCode).toBe(0);

    const objectsList = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "objects/" }),
    );
    const objectKey = objectsList.Contents?.[0]?.Key;
    expect(objectKey).toBeDefined();

    // A real multipart upload's ETag isn't a plain MD5 hex string -- it's
    // "<hex>-<partCount>" (e.g. "d41d8cd98f00b204e9800998ecf8427e-3"),
    // which is exactly what distinguishes it from a single-PUT upload.
    // This is what actually proves the multipart code path ran, not just
    // that the upload succeeded.
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey! }));
    expect(head.ETag).toMatch(/-\d+"?$/);

    const stubify = await runCli(["stubify", "large.bin", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(stubify.exitCode).toBe(0);
    expect(fs.existsSync(path.join(root, "large.bin"))).toBe(false);

    const materialize = await runCli(["materialize", "large.bin", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(materialize.exitCode).toBe(0);

    const roundTripped = fs.readFileSync(path.join(root, "large.bin"));
    expect(roundTripped.length).toBe(content.length);
    expect(hashBufferHex(roundTripped)).toBe(expectedHash);
    expect(roundTripped.equals(content)).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  }, 60000);
});
