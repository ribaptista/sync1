import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";
import { hashBufferHex, formatTaggedHash } from "../../src/crypto/hash.js";

const PASSWORD = "correct horse battery staple";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-matstub-"));
}

describe("materialize / stubify", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("round-trips content through stubify then materialize, byte-for-byte", async () => {
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
    const content = "the quick brown fox jumps over the lazy dog";
    fs.writeFileSync(path.join(root, "photo.jpg"), content);
    const syncResult = await runCli(["sync", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(syncResult.exitCode).toBe(0);

    const stubify = await runCli(["stubify", "photo.jpg", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(stubify.exitCode).toBe(0);
    const stubifyParsed = JSON.parse(stubify.stdout) as {
      ok: boolean;
      stubified: number;
      skipped: unknown[];
    };
    expect(stubifyParsed).toMatchObject({ ok: true, stubified: 1, skipped: [] });
    expect(fs.existsSync(path.join(root, "photo.jpg"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "photo.jpg.stub"), "utf8")).toBe(
      formatTaggedHash(hashBufferHex(Buffer.from(content))),
    );

    const materialize = await runCli(["materialize", "photo.jpg", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(materialize.exitCode).toBe(0);
    const materializeParsed = JSON.parse(materialize.stdout) as {
      ok: boolean;
      materialized: number;
    };
    expect(materializeParsed).toMatchObject({ ok: true, materialized: 1 });
    expect(fs.existsSync(path.join(root, "photo.jpg.stub"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "photo.jpg"), "utf8")).toBe(content);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stubify refuses a file with uncommitted local changes", async () => {
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
    fs.writeFileSync(path.join(root, "a.txt"), "original");
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    // edit again without syncing -- cache.db now shows a pending change
    fs.writeFileSync(path.join(root, "a.txt"), "edited, not yet synced");
    await runCli(["update_cache", "--root", root, "--json"]);

    const result = await runCli(["stubify", "a.txt", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      stubified: number;
      skipped: Array<{ path: string; reason: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.stubified).toBe(0);
    expect(parsed.skipped).toHaveLength(1);
    expect(parsed.skipped[0]!.reason).toMatch(/not fully committed/);
    // file untouched
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("edited, not yet synced");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("update_cache rejects a manually-created stub referencing an unknown hash", async () => {
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
    fs.writeFileSync(path.join(root, "phantom.jpg.stub"), formatTaggedHash("f".repeat(64)));

    const result = await runCli(["update_cache", "--root", root, "--json"]);
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; error: string };
    expect(parsed.error).toMatch(/isn't known in this vault/);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("auto-cleans a dangling stub left alongside its real file", async () => {
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
    const content = "real content wins";
    fs.writeFileSync(path.join(root, "a.txt"), content);
    // simulate an interrupted materialize: real file already written, stub
    // never got cleaned up
    fs.writeFileSync(
      path.join(root, "a.txt.stub"),
      formatTaggedHash(hashBufferHex(Buffer.from(content))),
    );

    const result = await runCli(["update_cache", "--root", root, "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { created: number };
    expect(parsed.created).toBe(1);
    expect(fs.existsSync(path.join(root, "a.txt.stub"))).toBe(false); // cleaned up
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe(content); // real file intact

    fs.rmSync(root, { recursive: true, force: true });
  });
});
