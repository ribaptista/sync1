import { Readable, Transform } from "node:stream";

/** Wraps a stream with a byte counter, for progress bars -- never buffers, just observes chunk sizes as they pass through. */
export function countingReadable(source: Readable, onBytes: (n: number) => void): Readable {
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });
  return source.pipe(counter);
}
