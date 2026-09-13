import type { OptionValues } from "commander";
import type { ConcurrencyPoolOptions } from "../concurrency/pools.js";

export interface GlobalConcurrencyOptions extends OptionValues {
  s3MetadataParallelism?: string;
  hashParallelism?: string;
  fileStreamParallelism?: string;
}

function parsePositiveInt(raw: string, flagName: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`invalid ${flagName} "${raw}" — expected a positive integer`);
  }
  return n;
}

/** Turns the raw --*-parallelism CLI strings into createConcurrencyPools' options, validating each. */
export function resolveConcurrencyOptions(opts: GlobalConcurrencyOptions): ConcurrencyPoolOptions {
  const resolved: ConcurrencyPoolOptions = {};
  if (opts.s3MetadataParallelism !== undefined) {
    resolved.s3MetadataParallelism = parsePositiveInt(
      opts.s3MetadataParallelism,
      "--s3-metadata-parallelism",
    );
  }
  if (opts.hashParallelism !== undefined) {
    resolved.hashParallelism = parsePositiveInt(opts.hashParallelism, "--hash-parallelism");
  }
  if (opts.fileStreamParallelism !== undefined) {
    resolved.fileStreamParallelism = parsePositiveInt(
      opts.fileStreamParallelism,
      "--file-stream-parallelism",
    );
  }
  return resolved;
}
