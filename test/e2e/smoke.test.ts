import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";

describe("scaffolding smoke test", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  it("starts LocalStack and creates a fresh empty bucket", async () => {
    const client = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(client);
    const res = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    expect(res.KeyCount ?? 0).toBe(0);
  });

  it("sync1 --help works as a real spawned process", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sync1");
  });
});
