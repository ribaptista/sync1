# Stub files

## Self-describing content, not zero-byte placeholders

A stub is `<path>.stub` containing an algorithm-tagged hash string (e.g. `blake2b:<hex>`) — never a
zero-byte file. This is the detail that makes the whole mechanism work: a stub is _verifiable_ purely
from its own content plus the vault's already-known objects, without any separate bookkeeping about
"which stubs are legitimate." Anyone (or any process) can hand-create a stub for a path, and
`update_cache` can tell on its own whether that stub is trustworthy — it just checks the format and
looks the declared hash up in `objects`.

One consequence worth being deliberate about: since a stub only needs to name a hash that's already
backed up somewhere in the vault, you can create a new path referencing already-deduped content (or
reorganize existing stubs into a different folder structure) purely by writing/moving `.stub` files —
no bytes need to be downloaded or even exist locally to do this.

## The four-state representation logic

For any tracked path, the filesystem holds one of: absent, a real file, a stub, or both (a stub
dangling next to an already-materialized real file, most often from an interrupted `materialize`).
`update_cache`'s walker (`src/fs/walker.ts`) merges a `<name>` and `<name>.stub` pair into one logical
entry carrying a `representation` field, so none of the create/modified/deleted decision logic
downstream needs to know or care which physical form backs a path:

- **absent** → the ordinary "path no longer exists" deletion path — nothing stub-specific about it.
- **real** → hash the actual bytes, exactly as always.
- **stub** → read the self-declared hash (never hash the stub's own, contentless bytes) and validate it
  against `objects` — a malformed stub is a distinct corruption error; a well-formed stub naming a hash
  this vault has never actually backed up is a distinct "unknown content" error. Either way,
  `update_cache` fails loudly rather than silently accepting an unverifiable claim.
- **both** → the real file always wins; the dangling stub is deleted as a side effect, with a warning
  logged. This is checked even when the real file's mtime hasn't changed since the cache's baseline
  (unlike the normal mtime-skip optimization), since the walker has already paid for that stat either
  way — there's no reason to let a stray stub linger just because nothing else about the path happened
  to change.

## Crash safety: opposite orderings for opposite operations

`materialize` (stub → real) downloads to a temp file, renames it into place, and only _then_ deletes the
stub. `stubify` (real → stub) writes the new stub atomically (temp file + rename) and only _then_
deletes the real file. Both orderings exist for the same reason: an interruption at any point leaves you
in the "both exist" state, which is always safe and already self-heals on the next `update_cache`/`sync`
(real file wins, stub cleaned up) — never a state where neither representation exists.

## `stubify`'s precondition reuses `update_cache`'s own freshness check

Before replacing a file with a stub, `stubify` needs to know the file is genuinely fully committed —
otherwise it would silently discard content that was never synced. Rather than always rehashing
(expensive for large files) or always trusting the cache row (a race window for files edited moments
ago), it reuses the same trick as `update_cache`: skip the rehash when the file's mtime still matches
the recorded baseline; rehash and require a match when it doesn't. This isn't a new mechanism, just the
existing one invoked for a single targeted file instead of a full scan.

## `sync`'s remote-apply defaults to a stub, preserves what's already there

The one place stub-awareness reaches outside `update_cache`/`materialize`/`stubify` is `sync`'s
remote-to-local application (`src/sync/apply-remote-changes.ts`). A path with **no existing local
representation at all** (the common case right after `attach_remote`, but also just "a new file someone
else created that this machine has never seen") defaults to writing a stub, never a download — this is
what makes `attach_remote` + `sync` a real restore without pulling down the entire backup. A path that's
**already known locally** preserves whatever representation currently backs it: already-stubbed stays a
stub (only its referenced hash is updated — no download at all, even for a "modified" remote change);
already-materialized stays materialized (the new content is downloaded, same as before stubs existed).
`sync` itself never needs to reason about stubs beyond this one preservation check — the rest of the
merge algebra (`conflict-rules.ts`, the local-changes application) is completely unaware that stubs
exist at all, which is exactly the point: stub-awareness lives entirely in the filesystem-facing layer.
