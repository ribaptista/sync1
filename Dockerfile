# syntax=docker/dockerfile:1
#
# sync1 CLI image.
#
# Pinning strategy (verified live against upstream registries/archives when this file was
# written -- see the comment above each pin for how):
#   - Base OS/Node runtime: `node:22-trixie-slim`, pinned by both tag *and* content digest, so
#     the base layer can never silently change under a rebuild. Node 22 matches
#     docs/platform-setup.md's recommendation (Node 24 has a known better-sqlite3 teardown
#     abort -- see that doc's "Node version note"; harmless for a single long-running process
#     like this image's entrypoint, but 22 is what this project actually recommends and tests
#     against). Debian trixie is the base because it's the first Debian release whose
#     `imagemagick` package is a real ImageMagick 7 (7.1.1.43) -- docs/platform-setup.md
#     requires ">= 7"; Debian bookworm/bullseye/etc. only ship ImageMagick 6.
#   - ffmpeg/ImageMagick: installed via `apt-get install <pkg>=<exact-version>`, pinned to the
#     exact trixie package versions confirmed present via https://sources.debian.org/api/src/
#     at the time this file was written (ffmpeg 7:7.1.5-0+deb13u1 -- satisfies the ">= 4.4"
#     floor with a wide margin; imagemagick 8:7.1.1.43+dfsg1-1+deb13u12 -- satisfies ">= 7").
#     A version-pinned `apt-get install` fails loudly (not silently drifts) once Debian's
#     trixie archive supersedes either package with a newer security update. When that happens,
#     bump ARG IMAGEMAGICK_VERSION/FFMPEG_VERSION below to whatever `apt-cache policy
#     imagemagick ffmpeg` now reports. For a build that must reproduce bit-for-bit far into the
#     future regardless of what's still in the live trixie archive, point `apt-get`'s sources at
#     a fixed https://snapshot.debian.org/archive/debian/<YYYYMMDDTHHMMSSZ>/ snapshot instead of
#     the default mirror (see https://snapshot.debian.org for how to pick a serial that carries
#     both versions).
#   - Node dependencies: pinned by the repository's own committed package-lock.json via
#     `npm ci` (exact, hash-verified versions -- nothing invented here).
#
# Neither ImageMagick nor ffmpeg is needed for anything but the `thumbnail`/`thumbnail_policy`
# commands (see docs/platform-setup.md#external-media-tools) -- they're included unconditionally
# here so the image is fully self-contained, since a partial image would just fail later with a
# less clear error than a missing apt package would at build time.

ARG NODE_IMAGE=node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4

# ---- deps: install node_modules once, shared by the build and runtime stages ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3/sodium-native ship prebuilt binaries for linux-x64/arm64 glibc (see
# docs/platform-setup.md#verifying-native-dependencies) -- `npm ci` should never need to compile
# anything here. python3/make/g++ are installed anyway as a defensive fallback (removed again in
# this same layer) in case a prebuild is ever missing for the image's exact Node ABI/arch.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# ---- build: compile TypeScript ----
FROM deps AS build
COPY tsconfig.json tsconfig.typecheck.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# ---- prod-deps: node_modules pruned to production-only, same lockfile ----
FROM deps AS prod-deps
RUN npm prune --omit=dev

# ---- runtime: the actual image ----
FROM ${NODE_IMAGE} AS runtime

ARG IMAGEMAGICK_VERSION=8:7.1.1.43+dfsg1-1+deb13u12
ARG FFMPEG_VERSION=7:7.1.5-0+deb13u1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        tini \
        "imagemagick=${IMAGEMAGICK_VERSION}" \
        "ffmpeg=${FFMPEG_VERSION}" \
    && rm -rf /var/lib/apt/lists/* \
    # Fail the build loudly, not the first `thumbnail` run in production, if the pinned
    # packages ever stop providing what sync1 actually needs (docs/platform-setup.md's
    # ImageMagick >= 7 / ffmpeg >= 4.4 floors, and the exact binary names it shells out to --
    # see src/media/thumbnail-generate.ts / src/media/probe.ts).
    && identify -version | grep -qE 'ImageMagick 7\.' \
    && convert -version | grep -qE 'ImageMagick 7\.' \
    && ffmpeg -version | head -1 \
    && ffprobe -version | head -1

WORKDIR /app
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Runs as an unprivileged user, not the `node` image's default root -- this only ever touches
# whatever host directory is bind-mounted at runtime (see below) plus its own /app, never needs
# root, and there's no reason to give a mounted backup source tree root-owned access to it.
RUN groupadd --gid 1001 sync1 \
    && useradd --uid 1001 --gid sync1 --no-user-group --no-create-home \
        --home-dir /app --shell /usr/sbin/nologin sync1 \
    && chown -R sync1:sync1 /app
USER sync1

# tini as PID 1: forwards SIGINT/SIGTERM to node correctly and reaps the `identify`/`convert`/
# `ffmpeg`/`ffprobe` child processes thumbnail generation spawns (see src/media/thumbnail-
# generate.ts's runTool) -- without a real init, a killed container can leave zombies exactly
# like the ones seen debugging the fd-3 hang, harmless here (the container exits and the kernel
# reaps them anyway) but tini is the standard, correct fix and costs nothing.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/cli.js"]
# No default subcommand -- sync1 is a multi-command CLI (init_remote/attach_remote/sync/
# thumbnail/...), and guessing one would be wrong for most invocations. `--help` is a safe,
# informative default for `docker run <image>` with no arguments.
CMD ["--help"]

# --- Usage ---
#
# sync1 operates on a local directory tree (via --root, or the nearest ancestor directory
# with a .sync1/ when --root is omitted -- see resolveRoot) and needs that directory to persist
# across runs (it holds .sync1/{state,cache}.db, the vault lock, etc.), so bind-mount it rather
# than relying on the container's own filesystem:
#
#   docker run --rm -it \
#     --user "$(id -u):$(id -g)" \
#     -v /path/to/your/vault:/data \
#     -e SYNC1_PASSWORD \
#     <image> sync --root /data
#
# `--user "$(id -u):$(id -g)"` is not optional in practice: the image's baked-in `sync1` user
# (uid/gid 1001) almost never matches your bind-mounted directory's actual ownership, and
# without this override every write into it (a downloaded object, a generated thumbnail,
# .sync1/state.db itself) fails with EACCES -- confirmed directly: `convert`, run as the image's
# own uid 1001 against a bind mount owned by a host uid of 1000, fails with "Permission denied";
# the identical run with `--user "$(id -u):$(id -g)"` succeeds. Overriding `--user` at `docker
# run` time (rather than hardcoding a single uid/gid at build time) is what lets one image work
# unmodified regardless of which host user's directory it's pointed at.
#
# The vault password is read from $SYNC1_PASSWORD (see src/cli/password.ts) or, on a real TTY
# (-it), an interactive masked prompt -- it is never accepted as a CLI flag, so it never leaks
# into `docker inspect`'s recorded command or `ps` output the way `-e SYNC1_PASSWORD=<value>`
# directly on the command line would; prefer `--env-file` or your orchestrator's secret
# mechanism over a literal `-e SYNC1_PASSWORD=...` for anything beyond local testing.
