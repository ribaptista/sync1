import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { countingReadable } from "../../../src/fs/counting-stream.js";

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("countingReadable", () => {
  it("passes every byte through unchanged", async () => {
    const source = Readable.from([Buffer.from("hello "), Buffer.from("world")]);
    const result = await drain(countingReadable(source, () => {}));
    expect(result.toString()).toBe("hello world");
  });

  it("reports each chunk's size as it passes through, summing to the total", async () => {
    const source = Readable.from([Buffer.from("abc"), Buffer.from("de"), Buffer.from("f")]);
    const seen: number[] = [];
    const result = await drain(countingReadable(source, (n) => seen.push(n)));
    expect(seen).toEqual([3, 2, 1]);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(result.length);
  });
});
