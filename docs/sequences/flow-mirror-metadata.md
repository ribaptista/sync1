# Flow: mirroring the small keys

**Derived from:** `src/sync/mirror-metadata.ts`, `src/vault/mirror-paths.ts`

**Used by:** [`sync.md`](sync.md) (via [`flow-candidate-db.md`](flow-candidate-db.md)),
[`gc.md`](gc.md) and [`policy_edit.md`](policy_edit.md) (both via
[`flow-cas-commit.md`](flow-cas-commit.md))

The mirror is an optional second, offline copy of the encrypted vault. Content objects are mirrored
inline as they upload (see [`flow-apply-local-changes.md`](flow-apply-local-changes.md)); this flow
covers the three small, non-content keys — `states/<stamp>`, `current`, and `vault.json` — which every
one of the **three** commit paths (`sync`, `gc`, `mutateStateDb`/policy edits) mirrors identically,
through one shared pair of functions.

## Sequence

```mermaid
sequenceDiagram
    participant Commit as gc / mutateStateDb
    participant Resolver as mirrorPathFor
    participant FS
    participant Mirror as mirror filesystem

    note over Commit: after the S3 snapshot PUT succeeds
    Commit->>Resolver: mirrorPathFor(root, logger)
    Resolver->>FS: fs.readFileSync(remote.json) -> parseRemoteConfig -> resolveMirrorPath
    alt mirror_path absent, or malformed/inside the root
        Resolver-->>Commit: undefined (malformed case logs a warning first)
        note over Commit: every step below becomes a silent no-op
    else configured and well-formed
        Resolver-->>Commit: mirrorPath
    end

    note over Commit: sync resolves mirrorPath differently -- see the note below --<br/>but joins the same two calls from here on, passing its own mirrorPath directly
    Commit->>Mirror: mirrorStateSnapshot(mirrorPath, versionStamp, encryptedSnapshot)
    alt write succeeds
        Mirror-->>Commit: logger.debug("mirrored")
    else write fails (any reason)
        Mirror-->>Commit: logger.warn("could not mirror -- the commit itself<br/>succeeded; run mirror catchup")
    end

    note over Commit: only after S3's CAS on /current has ALSO succeeded
    Commit->>Mirror: mirrorCurrentPointer(mirrorPath, root, versionStamp)
    opt mirror/vault.json does not exist yet
        Mirror->>FS: fs.readFileSync(local vault.json)
        Mirror->>Mirror: writeMirrorFile(mirror/vault.json, bytes) -- same warn-only handling
    end
    Mirror->>Mirror: writeMirrorFile(mirror/current, versionStamp) -- same warn-only handling
```

## Notes

- **Concurrency:** none — two sequential, awaited writes, each internally atomic (temp-then-rename via
  `writeMirrorFile`; see [`flow-atomic-publish.md`](flow-atomic-publish.md)).
- **On failure: never fatal, by design.** By the time either of these runs, S3 has already accepted the
  snapshot and (for the pointer) the CAS has already landed — the vault is committed regardless of what
  happens to the mirror next. Throwing here would turn an already-successful commit into a reported
  failure, _after_ the point of no return, with nothing left for the caller to usefully retry. Every
  failure is a `logger.warn` naming `mirror catchup` as the fix, never an exception.
- **Ordering is the whole point.** The snapshot is written before the pointer, mirroring S3's own
  objects-then-snapshot-then-pointer sequence (see [`flow-cas-commit.md`](flow-cas-commit.md)) — so the
  mirror's `current` can never name a version whose snapshot the drive doesn't also hold.
  `mirror verify` depends on this: it judges completeness against **the mirror's own** `current` and
  snapshot, never the local `state.db`.
- **Why `gc` and `mutateStateDb` share `mirrorPathFor` rather than taking the path as a parameter:**
  resolving it locally, in one place, is what stops a fourth commit path from being added later and
  silently skipping the mirror by forgetting to thread a parameter through. This was not a hypothetical
  concern — `gc` originally _did_ miss this hook, and its snapshots never reached the mirror until that
  was found and fixed.
- **`sync` resolves its mirror path differently, and earlier — not through `mirrorPathFor` at all.**
  `src/commands/sync.ts`'s own `mirrorOptions()` calls `resolveMirrorPath` directly, once, before
  `performSync` even starts, and threads the result through as `MirrorOptions.path`. The difference is
  load-bearing: `resolveMirrorPath` **throws** on a malformed `mirror_path` (relative, or inside the
  vault root), so a broken config fails the whole sync fast, up front — whereas `mirrorPathFor` (used by
  `gc` and `mutateStateDb`, at commit time) swallows exactly that same error into `undefined` plus a
  warning. Neither variant checks _reachability_ (an unmounted drive) at resolution time; that surfaces
  later, per-write, as an ordinary mirror failure (see
  [`flow-apply-local-changes.md`](flow-apply-local-changes.md) for `sync`'s own tee/retry handling of
  that case). This is deliberately different again from `stubify`'s resolution of the mirror
  (`resolveReachableMirrorIfConfigured`/`requireReachableMirror` in `src/vault/mirror-paths.ts`), which
  checks reachability up front and throws for it — because stubify's gate exists to protect data, where
  silently proceeding as if unmirrored would be the wrong default, whereas a sync, policy edit, or gc
  sweep succeeding without its mirror copy is merely a gap for `mirror catchup` to close later.
- **Sub-flows:** [`flow-atomic-publish.md`](flow-atomic-publish.md) is what `writeMirrorFile` itself does.
