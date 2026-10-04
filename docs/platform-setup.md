# Platform setup

sync1 has been developed and tested on Linux. This covers what's needed to build and run it on macOS
and Windows too, plus how to verify the two native dependencies (`better-sqlite3`, `sodium-native`)
before relying on either platform for real. See
[cross-platform-filesystem.md](architecture/cross-platform-filesystem.md) for the filesystem-level work
(case-insensitivity, Windows file-locking) this setup is paired with.

## Prerequisites (all platforms)

- [Node.js](https://nodejs.org/) >= 20 — see [Node version note](#node-version-note) below for a caveat
  on Node 24 specifically
- git

## Node version note

Node 24 has a known native-addon teardown bug that hits `better-sqlite3` specifically: on process/worker
exit, `Database`'s destructor can race V8's own environment teardown, tripping a native assertion —
`node::RemoveEnvironmentCleanupHook(...) ... Assertion failed: (env) != nullptr` in `Database::~Database()`
— which aborts the process (SIGABRT / exit code 134) instead of exiting cleanly. It's intermittent (a
teardown race, not deterministic) and unrelated to anything sync1 itself does with the database. It's most
visible running this project's vitest e2e suite under Node 24: a worker aborts mid-run, and the reported
totals silently undercount (e.g. `npm run verify` reporting "31 passed (38)" with zero actual test
failures — the missing 7 simply never got a chance to report). A spawned `sync1` CLI subprocess can hit the
same abort on its own way out, which surfaces in a test as a bogus nonzero exit code rather than an
assertion.

Confirmed directly: the same e2e suite that aborts intermittently under Node 24 (`v24.21.0`) has not
reproduced the abort across many repeated runs under Node 22 (`v22.23.2`, current LTS), with no behavior
change otherwise. The bug is intermittent on both sides of that comparison, so treat this as "far less
frequent", not "proven impossible" —
**Node 22 is the recommended version for running this project's test suite** until this is fixed upstream
(in Node, V8, or `better-sqlite3`, not in this repo). Using Node 24 is fine for normal `sync1` usage — the
abort is a test-teardown artifact of running many short-lived `Database` instances back to back under a
worker pool, not something a single long-running `sync1` process is likely to hit — but if you do see a
vitest run undercount its own totals, or a CLI e2e test fail with an unexplained nonzero exit code, re-run
the specific missing/failing test file individually before treating it as a real regression; if it's this
issue, it passes on retry (or under Node 22).

If switching Node versions isn't an option, the abort is specifically a _cross-worker_ teardown race in
vitest's default pooled-forks runner — confirmed directly: the same suite that aborts under Node 24's
default pool ran clean, repeatedly, under Node 24 itself when forced onto a single worker process:

```bash
npx vitest run <test file> --pool=forks --poolOptions.forks.singleFork
```

This is a workaround, not a fix — it serializes the whole run onto one process (no cross-file
parallelism), so it's meaningfully slower on the full suite. Reach for it when you need a clean signal from
one specific e2e file on Node 24 without switching to Node 22 (e.g. a quick one-off check); prefer Node 22
for anything longer, including the full `npm run verify` gate.

Whichever Node version you use, `better-sqlite3`'s prebuilt binary is ABI-specific — after switching Node
versions (e.g. via `nvm use`), run `npm rebuild better-sqlite3` before running anything that touches the
database, or you'll hit a `NODE_MODULE_VERSION` mismatch error instead.

## Linux

```bash
git clone <repo-url> sync1
cd sync1
npm install
npm run build
node dist/cli.js --help
```

## macOS

Same as Linux:

```bash
git clone <repo-url> sync1
cd sync1
npm install
npm run build
node dist/cli.js --help
```

If `npm install` ever needs to compile a native dependency from source instead of using a prebuilt
binary (see [Verifying native dependencies](#verifying-native-dependencies) below), install the Xcode
Command Line Tools first:

```bash
xcode-select --install
```

## Windows

Same steps, from PowerShell:

```powershell
git clone <repo-url> sync1
cd sync1
npm install
npm run build
node dist/cli.js --help
```

If `npm install` needs to compile a native dependency from source, it needs a C++ toolchain and Python,
neither of which ship with Windows by default:

- Visual Studio Build Tools, with the **"Desktop development with C++"** workload
- Python 3

## External media tools

Thumbnail generation (`thumbnail`/`thumbnail_policy`) shells out to already-installed binaries rather
than bundling a native-addon alternative — see
[thumbnails.md](architecture/thumbnails.md#external-tools-not-a-new-npm-dependency) for why. Not needed
for anything else this project does; skip this section entirely if thumbnails aren't in use.

- **ImageMagick** (`identify`/`convert`) >= 7 — developed and tested against `7.1.2-18`. Needed for image
  thumbnails and CR2 raw mime-type detection.
- **ffmpeg**/**ffprobe** >= 4.4 — developed and tested against `8.0.1`. The `>= 4.4` floor is load-bearing,
  not just a "developed against" note: that's the version `-autorotate` defaulted on, which video mosaic
  generation's rotation handling depends on for correctness (a video display-rotated but not physically
  re-encoded would come out wrong on an older ffmpeg that doesn't auto-rotate decoded frames by default).

Neither is installed by `npm install` — install them via your platform's normal package manager (e.g.
`apt install imagemagick ffmpeg` on Debian/Ubuntu, `brew install imagemagick ffmpeg` on macOS). Missing
either one doesn't break anything else in sync1; only the `thumbnail`/`thumbnail_policy` commands need
them, and they fail with a clear "not found on PATH" error (`MediaToolMissingError`) rather than a cryptic
one if you try to use them without the tool installed.

## Docker

The repository's [`Dockerfile`](../Dockerfile) builds a self-contained image with the CLI and both
external media tools above already installed and pinned — no separate `npm install`/`apt install` step,
and no risk of an unnoticed ImageMagick 6 (the `>= 7` floor above, silently unmet) or a too-old ffmpeg.
This is the fastest way to get a fully working `sync1` — including thumbnails — without touching the
host at all.

```bash
docker build -t sync1 .
```

Every command needs the vault's directory available inside the container, so bind-mount it rather than
relying on the container's own filesystem — the mount is what persists `.sync1/{state,cache}.db`, the
vault lock, and every tracked file across separate `docker run` invocations, the same way a real
directory on disk does when running natively:

```bash
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -v /path/to/your/vault:/data \
  -e SYNC1_PASSWORD \
  sync1 sync --root /data
```

`--user "$(id -u):$(id -g)"` is not optional in practice — the image runs as its own unprivileged user by
default, whose uid/gid essentially never matches an arbitrary bind-mounted host directory's ownership,
and every write into it (a downloaded object, a generated thumbnail, `.sync1/state.db` itself) fails
with a permission error otherwise. The vault password is read from `$SYNC1_PASSWORD` (as above) or, on a
real TTY (`-it`), an interactive masked prompt — never as a CLI flag (see [`src/cli/password.
ts`](../src/cli/password.ts)).

The image's `ENTRYPOINT` is the CLI itself, so any subcommand works the same way — e.g. `... sync1
thumbnail ensure --root /data` — and running the image with no arguments at all prints `--help`.

The `Dockerfile` pins its base image by content digest and both media tools by exact Debian package
version (verified against the same `>= 7`/`>= 4.4` floors this doc documents above); see the comments at
the top of the file for exactly how those versions were chosen and how to update them later, including
the tradeoff of an exact-version `apt-get install` eventually being superseded by a Debian security
update.

### Multi-platform (arm64)

The image builds and runs correctly on `linux/arm64` (Apple Silicon, Raspberry Pi, AWS Graviton, etc.),
not just `linux/amd64` — confirmed directly, not just inferred from published package listings: built
and ran the actual `Dockerfile` under `docker buildx` with QEMU emulation, exercised `better-sqlite3` and
`sodium-native` (the two native Node addons, the real risk on a non-amd64 architecture) with real
database/hash operations, and round-tripped an image through `convert`/`identify` via the same
bind-mount `--user` flow as amd64. Everything the image depends on already publishes arm64 builds: the
pinned `node:22-trixie-slim` base is a multi-arch manifest list including `linux/arm64/v8`, both
`better-sqlite3` and `sodium-native` ship `linux-arm64` (glibc) prebuilds, and Debian trixie's archive
carries the exact same pinned `ffmpeg`/`imagemagick` package versions for `arm64` as for `amd64`.

On a machine that's natively arm64 (e.g. Apple Silicon), the plain commands above already produce a
native arm64 image — no extra flags needed. Cross-building arm64 from an amd64 host (or vice versa)
needs `docker buildx` plus QEMU emulation registered once per host:

```bash
docker run --rm --privileged tonistiigi/binfmt --install all   # one-time, registers QEMU for all archs
docker buildx create --use                                      # one-time, a build-capable builder

docker buildx build --platform linux/arm64 -t sync1 --load .
```

`--load` pulls the built image into the local `docker images` list (as `docker build` does implicitly);
omit it (and add `--push`) when building for a registry instead. Emulated cross-builds are meaningfully
slower than a native build on that architecture — the `apt-get install` step alone ran several minutes
longer under emulation in testing — but produce a bit-identical result to a native arm64 build.

### Pulling a published image

Every tagged release publishes a multi-arch (`linux/amd64` + `linux/arm64`) image built from this
same `Dockerfile` — no local build needed at all:

```bash
docker pull ghcr.io/ribaptista/sync1:latest       # or docker.io/<dockerhub-repo>, public.ecr.aws/<alias>/sync1
```

`:latest` always points at the newest non-prerelease version; a specific release is also available as
`:<version>` (e.g. `:1.2.3`), `:<major>.<minor>`, and (once past `0.x`) `:<major>`. See
[`docs/architecture/release.md`](architecture/release.md) for exactly how and when these get built and
tagged.

## Running without building

`npm run dev` (all platforms) runs the CLI directly from TypeScript source via `tsx`, without a build
step — useful for development, not for a real install.

## Verifying native dependencies

`better-sqlite3` and `sodium-native` are both native Node addons. Both are confirmed to ship prebuilt
binaries for `darwin-arm64`, `darwin-x64`, `win32-arm64`, and `win32-x64` as of the versions this project
pins (checked directly: `sodium-native` bundles every platform's prebuild inside its own npm package,
independent of the install host; `better-sqlite3` fetches a matching prebuild from its GitHub releases
at install time). In the normal case, **`npm install` should never need to compile anything** on either
platform — a source build only kicks in if a matching prebuild is missing for your exact Node version and
architecture.

To confirm a real install actually used a prebuild rather than compiling from source, watch `npm
install`'s output for a `node-gyp rebuild` line (its absence means a prebuild was used) — or, after
install, run the tool and confirm it starts without errors:

```bash
node dist/cli.js --help
```

If a source build ever _is_ triggered and fails, that's when the prerequisites above (Xcode Command Line
Tools on macOS; Visual Studio Build Tools + Python on Windows) are needed.

## Verifying the tool works end-to-end

Once built, the fastest way to confirm everything actually functions on a given platform is to run it
against a real (or LocalStack) S3 bucket by hand:

```bash
node dist/cli.js init_remote --bucket <bucket> --root <a-test-directory>
```

then create a file or two under that directory and run `sync`. This exercises the native dependencies,
the filesystem layer, and the S3 client together, which is a stronger signal than any individual check
above.
