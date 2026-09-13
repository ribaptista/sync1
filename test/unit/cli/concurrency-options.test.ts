import { describe, it, expect } from "vitest";
import { resolveConcurrencyOptions } from "../../../src/cli/concurrency-options.js";

describe("resolveConcurrencyOptions", () => {
  it("leaves every knob unset when no flags were passed", () => {
    expect(resolveConcurrencyOptions({})).toEqual({});
  });

  it("parses each provided flag as a positive integer", () => {
    expect(
      resolveConcurrencyOptions({
        s3MetadataParallelism: "2",
        hashParallelism: "16",
        fileStreamParallelism: "3",
      }),
    ).toEqual({ s3MetadataParallelism: 2, hashParallelism: 16, fileStreamParallelism: 3 });
  });

  it.each([
    ["s3MetadataParallelism", "--s3-metadata-parallelism"],
    ["hashParallelism", "--hash-parallelism"],
    ["fileStreamParallelism", "--file-stream-parallelism"],
  ] as const)("rejects a non-integer value for %s", (key, flagName) => {
    expect(() => resolveConcurrencyOptions({ [key]: "abc" })).toThrow(flagName);
  });

  it.each(["0", "-1", "1.5"])("rejects %s as not a positive integer", (raw) => {
    expect(() => resolveConcurrencyOptions({ hashParallelism: raw })).toThrow("--hash-parallelism");
  });
});
