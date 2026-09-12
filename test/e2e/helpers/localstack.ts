import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";

const execFileAsync = promisify(execFile);

// Pinned per the Task 0 spike: `latest` requires a Pro license and quits on
// startup; `3.8` lacks If-Match conditional PutObject support (only
// If-None-Match works). 4.0 is the community edition confirmed to support
// both, which the whole CAS design depends on.
const LOCALSTACK_IMAGE = "localstack/localstack:4.0";

export interface LocalStackHandle {
  endpoint: string;
  containerName: string;
  stop: () => Promise<void>;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("failed to allocate a free port"));
      }
    });
    srv.on("error", reject);
  });
}

async function waitForHealth(endpoint: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint}/_localstack/health`);
      if (res.ok) {
        const body = (await res.json()) as { services?: Record<string, string> };
        if (body.services?.s3 === "available" || body.services?.s3 === "running") {
          return;
        }
      }
    } catch {
      // not up yet, keep polling
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`LocalStack did not become healthy within ${timeoutMs}ms`);
}

export async function startLocalStack(): Promise<LocalStackHandle> {
  const port = await getFreePort();
  const containerName = `sync1-e2e-${randomUUID()}`;
  await execFileAsync("docker", [
    "run",
    "-d",
    "--name",
    containerName,
    "-p",
    `${port}:4566`,
    "-e",
    "SERVICES=s3",
    LOCALSTACK_IMAGE,
  ]);

  const endpoint = `http://localhost:${port}`;
  await waitForHealth(endpoint);

  return {
    endpoint,
    containerName,
    stop: async () => {
      await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => {
        // best-effort cleanup
      });
    },
  };
}

export function createTestS3Client(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

export async function createFreshBucket(client: S3Client): Promise<string> {
  const bucket = `sync1-test-${randomUUID()}`;
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  return bucket;
}
