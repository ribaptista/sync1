/**
 * The progress-reporting shape shared by every content-processing domain
 * function (update_cache, sync, materialize, stubify, sanity_check) and
 * `src/cli/progress.ts`'s `BytesProgressSession`. Deliberately its own leaf
 * module rather than living in `src/cli/progress.ts`: `src/fs/*.ts` and
 * `src/sync/*.ts` never import from `src/cli/*` today (`cli` sits above
 * `fs`/`sync`, only `commands/*.ts` bridges them), and this type needs to be
 * importable from both sides of that boundary without inverting it.
 *
 * `filesDone`/`filesTotal` count every row a scan/merge-join consumes,
 * whether or not it actually needed hashing/uploading/downloading --
 * "how far through the tree" visibility, unchanged from what every command
 * already reported before byte tracking existed. `bytesDone`/`bytesTotal`
 * count only content actually hashed/uploaded/downloaded this run -- a
 * directory, an already-resolved stub, a no-op/unchanged/dedup-skip row,
 * and (for stubify) the common mtime-unchanged fast path all contribute 0
 * to both. This is what makes bytes a meaningful basis for an ETA where
 * item counts alone wouldn't be (file sizes vary wildly).
 */
export interface ProgressUpdate {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

export type OnProgress = (update: ProgressUpdate) => void;
