import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { createLogger } from "../../src/logger.js";

function collectingStream(): { stream: pino.DestinationStream; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, chunks };
}

describe("createLogger", () => {
  it("writes to the given destination instead of stderr (fd 2) when one is passed", () => {
    const { stream, chunks } = collectingStream();
    const logger = createLogger(true, stream);
    logger.debug({ hello: "world" }, "a debug message");
    expect(chunks.join("")).toContain("a debug message");
  });

  it("respects the verbose flag's level regardless of destination", () => {
    const quiet = collectingStream();
    createLogger(false, quiet.stream).debug({}, "should not appear");
    expect(quiet.chunks.join("")).toBe("");

    const loud = collectingStream();
    createLogger(true, loud.stream).debug({}, "should appear");
    expect(loud.chunks.join("")).toContain("should appear");
  });
});
