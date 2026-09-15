# sync1

A powerful, end-to-end encrypted backup tool for S3.

sync1 backs up a local directory to any S3-compatible bucket, encrypting everything on your own
machine before it ever leaves. It deduplicates identical content, works safely from more than one
machine backing up the same folder, and lets you keep old content on disk as a lightweight
placeholder instead of the full bytes. It's a single CLI binary with no server component.

## Features

- **S3-backed** — works with real AWS S3 or any S3-compatible endpoint (e.g. a self-hosted MinIO or
  LocalStack for testing).
- **End-to-end encrypted** — content is encrypted on your machine with a key derived from your
  password before upload. S3 never sees your password or your plaintext content, only ciphertext.
- **Deduplicated** — identical content is only ever stored once, even across different files, folders,
  or machines backing up the same vault.
- **Stub files** — a stub is a tiny placeholder file that stands in for a real file that's already
  safely backed up, without the actual bytes taking up local disk space. This is what makes restoring
  a huge backup onto a new machine instant instead of downloading everything: files show up as stubs,
  and you fetch the real content only for what you actually need, whenever you need it.
- **Thumbnails** — generate low-resolution image thumbnails and video mosaics for browsing a vault's
  actual content, governed by simple glob + mime-type policies (skip vs. generate), without
  materializing full-size originals.
- **S3 storage-class policies** — simple glob-pattern rules ("archive everything under `old/`") to
  move backed-up content into cheaper cold storage (Glacier, Deep Archive), with sync1 handling the
  copy/restore mechanics for you.
- **Multi-machine conflict detection** — back up the same folder from more than one machine. If two
  machines genuinely change the same file differently, sync1 flags it for you to resolve by hand
  instead of silently overwriting or corrupting anything — everything else in the same run still goes
  through.
- **Read-only diagnostics** — a `sanity_check` command cross-checks your local files against what's
  actually backed up (missing objects, tampered content, corrupt stubs) without ever repairing or
  touching anything, so you can safely audit a vault before trusting it.

## Getting started

Requires [Node.js](https://nodejs.org/) >= 20.

```bash
git clone <repo-url> sync1
cd sync1
npm install
npm run build
node dist/cli.js --help
```

See [`docs/platform-setup.md`](docs/platform-setup.md) for macOS/Windows-specific notes. The
walkthroughs below assume the built binary is available as `sync1` on your `PATH` — substitute
`node dist/cli.js` if you haven't linked it.

## Walkthroughs

Every example below uses the same running scenario: `~/backups/photos` on **machine A**, and
`~/backups/photos-b` on **machine B** — a second machine backing up (or restoring) the exact same
vault. In practice these can be two directories on the same computer or two entirely different
machines; sync1 doesn't care which.

### Initialize a vault

Create a brand-new vault, once, on the first machine:

```bash
mkdir -p ~/backups/photos
SYNC1_PASSWORD='correct horse battery staple' \
  sync1 init_remote --bucket my-backups --prefix photos --root ~/backups/photos
```

```
Initialized new vault at s3://my-backups/photos (version 20260101T020000000Z-a1b2c3d4)
```

### Sync a new file

Add a file and back it up:

```bash
cat > ~/backups/photos/hello.txt <<'EOF'
Hello from machine A!
EOF

SYNC1_PASSWORD='correct horse battery staple' sync1 sync --root ~/backups/photos
```

```
sync: version 20260101T020500000Z-b2c3d4e5 -- 1 objects uploaded, 0 deduped, 1 local entries changed, 0 remote created, 0 remote modified, 0 remote deleted
```

### Pull the vault onto another machine

Attach a second machine to the same vault, then sync:

```bash
mkdir -p ~/backups/photos-b
SYNC1_PASSWORD='correct horse battery staple' \
  sync1 attach_remote --bucket my-backups --prefix photos --root ~/backups/photos-b
```

```
Attached to vault at s3://my-backups/photos (version 20260101T020500000Z-b2c3d4e5). Run 'sync' to materialize files.
```

```bash
SYNC1_PASSWORD='correct horse battery staple' sync1 sync --root ~/backups/photos-b
```

```
sync: version 20260101T020500000Z-b2c3d4e5 -- 0 objects uploaded, 0 deduped, 0 local entries changed, 1 remote created, 0 remote modified, 0 remote deleted
```

Notice `hello.txt` didn't actually download yet — it arrived as a **stub** (`hello.txt.stub`), a tiny
file just naming the content it refers to. This is what makes attaching to a vault with years of
backed-up photos instant instead of downloading the whole thing up front.

### Stub a file

Back on machine A, suppose you don't need `hello.txt` taking up local disk space anymore — it's
already safely backed up, so replace it with a stub:

```bash
sync1 stubify hello.txt --root ~/backups/photos
```

```
stubify: 1 stubified, 0 already stub
```

`hello.txt` is now gone from disk on machine A, replaced by `hello.txt.stub` — the backup itself is
untouched.

### Materialize a file

Back on machine B, you actually want to open the file that was pulled down as a stub earlier — bring
back the real content:

```bash
SYNC1_PASSWORD='correct horse battery staple' sync1 materialize hello.txt --root ~/backups/photos-b
```

```
materialize: 1 materialized, 0 already real, 0 need retrieval (pass --request-retrieval), 0 retrieval requested, 0 pending
```

`hello.txt` is now a real file on disk on machine B, downloaded, decrypted, and verified against its
recorded hash.

### Generate thumbnails

Add a photo, then tell sync1 to generate a thumbnail for any JPEG:

```bash
cp ~/Pictures/sunset.jpg ~/backups/photos/sunset.jpg
SYNC1_PASSWORD='correct horse battery staple' \
  sync1 thumbnail_policy create "*.jpg" generate --root ~/backups/photos \
  --mime-types image/jpeg --image-width 320 --image-height 240 \
  --tile-rows 1 --tile-columns 1 --tile-width 320 --tile-height 240 --jpeg-quality 80
```

```
thumbnail policy 1 created (version 20260101T021200000Z-c3d4e5f6): *.jpg -> generate
```

Sync the new file so its content hash is recorded, then generate thumbnails for everything the policy
covers:

```bash
SYNC1_PASSWORD='correct horse battery staple' sync1 sync --root ~/backups/photos
sync1 thumbnail ensure --root ~/backups/photos
```

```
thumbnail ensure: 0 up to date, 1 to generate, 0 to regenerate, 0 to delete, 0 missing cache entry, 0 stubbed original, 0 error(s)
```

A small `sunset.jpg.<hash>.jpg` now sits in `_thumbnail/` next to the original — a preview you can
browse without materializing (or downloading) the full-size photo.

### Manage S3 storage classes

Add a policy moving older/less-important content to cheaper cold storage, then apply it:

```bash
SYNC1_PASSWORD='correct horse battery staple' \
  sync1 storage_policy create "*.txt" GLACIER --root ~/backups/photos
```

```
storage policy 2 created (version 20260101T021000000Z-d4e5f6a7): *.txt -> GLACIER
```

Check what would change before actually doing it:

```bash
sync1 status --root ~/backups/photos
```

```
status: 0 already correct, 1 need an immediate copy, 0 need a restore request, 0 restore pending, 0 ready to finalize
```

Apply it:

```bash
sync1 converge --root ~/backups/photos
```

```
converge: 0 already correct, 1 changed immediately, 0 restore requested, 0 restore pending, 0 finalized
```

Verify it actually completed:

```bash
sync1 status --root ~/backups/photos
```

```
status: 1 already correct, 0 need an immediate copy, 0 need a restore request, 0 restore pending, 0 ready to finalize
```

### Resolve a sync conflict

Suppose both machines edit `hello.txt` differently before either one syncs again:

```bash
# On machine A:
cat > ~/backups/photos/hello.txt <<'EOF'
Hello from machine A, take two!
EOF
SYNC1_PASSWORD='correct horse battery staple' sync1 sync --root ~/backups/photos
```

```bash
# On machine B, without pulling A's change first:
cat > ~/backups/photos-b/hello.txt <<'EOF'
Hello from machine B, a different edit!
EOF
SYNC1_PASSWORD='correct horse battery staple' sync1 sync --root ~/backups/photos-b
```

```
sync: version 20260101T021500000Z-e5f6a7b8 -- 0 objects uploaded, 0 deduped, 0 local entries changed, 0 remote created, 0 remote modified, 0 remote deleted
1 conflict(s) left unresolved:
  - hello.txt: "hello.txt" was modified both locally and remotely with different content
```

(exit code `2`.) Machine B's local `hello.txt` is left exactly as it was — nothing is overwritten or
lost. To resolve it, decide which version should win, make the file match that on disk, and run `sync`
again.

## Learn more

This README stays intentionally short. For the full command reference (every flag, every command) and
the architecture write-ups behind the design (encryption, the conflict matrix, storage-class model,
and more), see [`docs/`](docs/README.md).
