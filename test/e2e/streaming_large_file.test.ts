import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";
import { DEFAULT_CHUNK_SIZE } from "../../src/crypto/chunked-codec.js";
import { hashBufferHex } from "../../src/crypto/hash.js";

const PASSWORD = "correct horse battery staple";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-streaming-"));
}

describe("streaming encrypt/decrypt for a multi-chunk file", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("uploads and materializes a file spanning several chunk boundaries, byte-for-byte", async () => {
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

    // 2.5x the default chunk size -- exercises multiple full chunks plus a
    // partial final chunk through the real upload/download path (not just
    // the unit-level codec).
    const size = Math.floor(DEFAULT_CHUNK_SIZE * 2.5);
    const content = crypto.randomBytes(size);
    fs.writeFileSync(path.join(root, "video.bin"), content);
    const expectedHash = hashBufferHex(content);

    const syncResult = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(syncResult.exitCode).toBe(0);

    const stubify = await runCli(["stubify", "video.bin", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(stubify.exitCode).toBe(0);
    expect(fs.existsSync(path.join(root, "video.bin"))).toBe(false);

    const materialize = await runCli(["materialize", "video.bin", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(materialize.exitCode).toBe(0);

    const roundTripped = fs.readFileSync(path.join(root, "video.bin"));
    expect(roundTripped.length).toBe(content.length);
    expect(hashBufferHex(roundTripped)).toBe(expectedHash);
    expect(roundTripped.equals(content)).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
