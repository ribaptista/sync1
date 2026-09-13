// Runs INSIDE a piscina worker thread (see src/concurrency/pools.ts) --
// genuine multi-core parallelism for hashing many *different* files, since
// each file's BLAKE2b hash is independent, computed from a plain file path
// with no shared state and a tiny (hex string) result. `better-sqlite3`
// connections aren't transferable across threads, so this worker never
// touches any database -- it's given a path, it returns a hash, nothing else.
import { hashFile } from "../fs/hash-file.js";

export default function hashFileTask(absolutePath: string): Promise<string> {
  return hashFile(absolutePath);
}
