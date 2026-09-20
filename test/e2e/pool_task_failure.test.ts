import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";
import { hashBufferHex } from "../../src/crypto/hash.js";
import { objectKey } from "../../src/vault/paths.js";

const PASSWORD = "correct horse battery staple";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-pool-task-failure-"));
}

/**
 * A dispatched download/upload job's rejection used to become a genuinely
 * unhandled promise rejection (see src/concurrency/pools.ts's
 * dispatchTracked/throwIfPoolErrored), which crashes the whole process with
 * a raw, uncaught stack trace -- bypassing the command's own try/catch,
 * `emitError`, and lock release. This exercises the fix end-to-end, through
 * a real spawned process against real LocalStack: a materialize whose
 * backing S3 object has vanished must still exit cleanly, with a real
 * `--json` error payload (not empty/garbled stdout from a crash) and the
 * lock released for the next command.
 */
describe("a dispatched pool job's failure is reported cleanly, not an unhandled rejection", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("materialize against a vanished S3 object exits non-zero with a clean JSON error, and releases the lock", async () => {
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

    const content = "will be deleted straight out of S3";
    fs.writeFileSync(path.join(root, "photo.jpg"), content);
    const sync1 = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(sync1.exitCode).toBe(0);

    const stubify = await runCli(["stubify", "photo.jpg", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(stubify.exitCode).toBe(0);

    // Delete the backing object directly out of the bucket -- materializing
    // the stub now has nothing to actually download.
    const hash = hashBufferHex(Buffer.from(content));
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(hash) }));

    const materialize = await runCli(["materialize", "photo.jpg", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });

    // Exit code 3 (EXIT_CORRUPTION): a real, classified error, never the
    // exit code the OS gives a raw uncaught-exception crash. And if the
    // process really did crash, stdout would be empty/garbled -- JSON.parse
    // failing right here is what would actually surface that regression,
    // not a downstream assertion on some specific field.
    expect(materialize.exitCode).toBe(3);
    const parsed = JSON.parse(materialize.stdout) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/missing in S3/);
    // No raw crash text leaked onto stderr either -- just this run's own
    // logging.
    expect(materialize.stderr).not.toMatch(/UnhandledPromiseRejection|at process\./);

    // The lock was released despite the failure: a second command against
    // the same root right after must fail the *same clean way* again (the
    // object is still gone) rather than with a lock conflict -- if the
    // first run's failure had left the lock held, this would instead come
    // back as EXIT_CONFLICT/VaultLockedError, a clearly different outcome
    // from the corruption error being re-asserted here.
    const again = await runCli(["materialize", "photo.jpg", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(again.exitCode).toBe(3);
    const againParsed = JSON.parse(again.stdout) as { ok: boolean; error: string };
    expect(againParsed.error).toMatch(/missing in S3/);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
