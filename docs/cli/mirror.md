# `sync1 mirror`

Inspects and repairs the optional local mirror — a second, offline copy of the **encrypted** vault, held
on a local directory or network mount. Enabled by adding `mirror_path` to `.sync1/remote.json`; without
it, every subcommand here errors rather than reporting a comforting zero.

See [mirroring.md](../architecture/mirroring.md) for how the mirror is written and why it is laid out
the way it is. This page is about reading it back.

## Usage

```bash
sync1 mirror verify  [--root <path>] [--quick] [--checksum] [--offline] [--json]
sync1 mirror catchup [--root <path>] [--allow-download] [--json]
sync1 mirror prune   [--root <path>] [--apply] [--json]
```

## What each one needs

|                                | Password | Network                  | Writes     |
| ------------------------------ | -------- | ------------------------ | ---------- |
| `verify --quick`               | no       | yes (unless `--offline`) | no         |
| `verify` / `verify --checksum` | yes      | yes (unless `--offline`) | no         |
| `catchup`                      | yes      | **yes**                  | the mirror |
| `prune`                        | yes      | no                       | the mirror |

`catchup` is the one that genuinely cannot work offline: it fetches the snapshot and pointer from S3.
Object content, by contrast, comes from local plaintext wherever possible and costs no egress at all.

---

## `mirror verify`

Answers one question: **is this drive, by itself, a complete and restorable backup?** — not "does it
agree with this machine".

That distinction decides everything else here. Object completeness is measured against **the mirror's
own `current` pointer and the snapshot it names**, never the local `state.db`. Reading the local
database instead would miss a `current` pointing at an absent snapshot, would render a legitimately
_behind_ mirror as an unexplained heap of missing objects, and would measure against a broken ruler if
that database were itself corrupt or from another vault.

### Steps, in order

1. Resolve `mirror_path`; error clearly if unset or unreachable.
2. **`vault.json` must be byte-identical to the local one.** Checked first because it is the failure
   most likely to go unnoticed and the one that invalidates every later result: a different salt or
   verifier means the drive belongs to a _different vault_.
3. Read `<mirror>/current`.
4. Confirm the snapshot it names exists and is non-empty. A pointer naming an absent snapshot is fatal
   on its own — the mirror is unrestorable regardless of how many objects are present, and saying so
   is far more useful than emitting thousands of missing-object rows.
5. Compare against **S3's** `/current` — one tiny GET, and the authoritative answer. `--offline`
   compares against this machine's `last_synced_version` instead, and the output names which reference
   it used, because assurance measured against a possibly-stale local file is weak assurance.
6. _(`--quick` stops here.)_
7. Decrypt the mirror's snapshot and check every object it references: present, right size, and with
   `--checksum`, matching its recorded CRC64NVME.
8. Report object files the snapshot does not reference (`extra`), and orphaned `.sync1-tmp-*`.

### Flags

Two orthogonal axes — **depth** and **reference**:

| Flag         | Effect                                                                           |
| ------------ | -------------------------------------------------------------------------------- |
| `--quick`    | Pointer and snapshot presence only. No password, no object sweep. Cron-friendly. |
| _(default)_  | Full sweep at `stat` + size depth. Seconds over tens of thousands of objects.    |
| `--checksum` | Additionally hashes every stored byte. Reads the whole mirror, so it is opt-in.  |
| `--offline`  | Compare against local `last_synced_version` rather than S3.                      |

The checksum it compares against is **S3-corroborated**: `putObjectStream` refuses to return unless
S3's independently-computed value matched the client's. So a deep check verifies the mirror against a
number S3 agreed to, without touching S3.

### Output

```
mirror verify (presence): up to date
  33871 object(s) checked -- 0 missing, 0 wrong size, 0 checksum mismatch
  0 extra (not referenced by this snapshot), 0 stale temp(s)
```

**`extra` is not a failure**, and neither is being behind. `gc`'s scope is the vault's current live
state, so objects it removed from S3 survive here deliberately — that is the mirror's value as a safety
net against your own mistaken delete. And a mirror that is simply behind is what `catchup` exists for;
reporting it as broken would make the one command you run on a schedule cry wolf.

Exit code is non-zero only for `missing`, `wrong_size` or `checksum_mismatch` — actual damage.

---

## `mirror catchup`

Writes whatever the mirror is missing.

**Metadata comes straight from S3**, unconditionally and without `--allow-download`: `vault.json`,
`current`, and the one snapshot `current` names. These are megabytes where the objects are hundreds of
gigabytes, so the egress this feature exists to avoid is not at stake — and applying the same parsimony
here would buy nothing while leaving the mirror unreadable.

**Snapshot history is deliberately not backfilled.** `gc` removes objects not referenced by the current
live state, so an object referenced only by an old snapshot is already gone from S3 — historical
snapshots are partially dangling there too. Fetching them would import a completeness target nobody can
ever meet. Snapshots accumulated going _forward_ (written as each sync commits) are a forensic record;
history never mirrored is worth nothing extra.

**Objects come from local plaintext**, free and byte-identical thanks to convergent encryption. For
each missing object, catchup walks _every_ path that references it — in a deduped vault several paths
share one object, and one may still hold the original bytes while another was edited. Paths whose cache
row is not `unchanged`, or whose size disagrees, are skipped without being read.

The source it does read is then checked at both ends in one pass, with the rename as the gate: the
plaintext must hash to the object's own hash, **and** the ciphertext must match the recorded checksum.
Either fails and nothing is published. Without that, catchup would be a silent-corruption engine —
`objects` has no path column, so a source is found through `entries.hash`, and that path may no longer
hold the content the object was made from.

An object with no usable local source is reported as `unrecoverable_locally` rather than guessed at.

---

## `mirror prune`

Removes mirror object files the current snapshot no longer references.

Adopts `gc`'s own scope: the vault's current live state. This is not a new loss — `gc` already applied
that rule to S3 — but it does mean objects referenced only by older snapshots go away, making those
snapshots less materialisable. Opt-in and separate from `gc` precisely so the safety-net property
survives until you deliberately give it up.

Count-only by default; `--apply` actually deletes, matching `gc`'s own shape.

---

## Examples

```bash
sync1 mirror verify --quick --json
```

```bash
sync1 mirror verify --checksum --root /run/media/ri/ri_data/organized
```

```bash
sync1 mirror catchup --root /run/media/ri/ri_data/organized
```

```bash
sync1 mirror prune --apply --root /run/media/ri/ri_data/organized
```
