import { Readable, Transform, pipeline } from "node:stream";

/**
 * Wraps a stream with a byte counter, for progress bars -- never buffers,
 * just observes chunk sizes as they pass through.
 *
 * Built on `pipeline(source, counter, ...)` rather than `source.pipe(counter)`
 * deliberately: `pipe` never forwards `error` from its source to its
 * destination, so a mid-read failure (ENOENT, EIO) would leave `counter`
 * stuck open -- neither `end()`ed nor errored -- and a consumer blocked on
 * `readExact`-style logic downstream would hang forever instead of seeing
 * the failure. `pipeline` destroys both streams and forwards the error to
 * whichever end the caller is actually consuming, here the returned
 * `counter`. The no-op callback is required by `pipeline`'s signature but
 * not by us: errors surface by `counter` itself emitting `error`, which is
 * what a `for await` or `.pipe()` consumer downstream already listens for.
 */
export function countingReadable(source: Readable, onBytes: (n: number) => void): Readable {
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });
  pipeline(source, counter, () => {});
  return counter;
}
