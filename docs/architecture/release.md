# Release workflow: multi-arch Docker image → GHCR, ECR Public, Docker Hub

How cutting a release publishes the `Dockerfile` image, built for both `linux/amd64` and
`linux/arm64`, to GHCR, Docker Hub, and ECR Public. Implemented by
[`.github/workflows/release.yml`](../../.github/workflows/release.yml), which reuses
[`.github/workflows/verify.yml`](../../.github/workflows/verify.yml) as its gate;
[`.github/workflows/docker-canary.yml`](../../.github/workflows/docker-canary.yml) is a separate,
unrelated-to-releasing safety net (see "apt pins going stale" below).

## Cutting a release

```bash
npm version minor       # 0.1.0 -> 0.2.0: bumps package.json + package-lock.json, commits, tags v0.2.0
git push --follow-tags  # pushes main AND the tag -> triggers release.yml
```

For a prerelease, `npm version prerelease --preid rc` instead, which produces `v0.2.0-rc.0`. That
tag is still published to every registry, but without the `:latest` tag, and the GitHub Release it
creates is marked as a prerelease.

**`npm version <bump>` is the only supported way to cut a release.** It is what keeps
`package.json`'s `version` and the git tag from ever disagreeing, and `check-version` (the first job
in `release.yml`) enforces that invariant directly: it fails the entire run before anything is built
if `v<package.json version>` doesn't match the tag that was actually pushed. A bare `git tag v9.9.9`
(not produced by `npm version`) is refused the same way. There is no manual "create a release" step
on the repository's web page at any point — the GitHub Release itself is created by the workflow's
own last job, and only after every image has actually landed in every registry, so a release page
can never point at an image that failed to publish.

## Why a tag push, not a manual GitHub Release

GitHub lets you trigger a workflow either way (`on: push: tags` or `on: release: published`). A tag
push was chosen because `npm version` already produces the tag as a side effect of the one command
that also bumps `package.json` — reusing that tag as the trigger means there is exactly one step to
remember, and the version-match invariant above has something to check itself against. Driving this
from a hand-created GitHub Release would invert the natural order (you'd create the release, then
hope the version you typed into the web form matches what's actually in `package.json` on whatever
commit the release points at) and adds a second, easy-to-forget place to specify a version.

## Jobs (`release.yml`)

1. **check-version** — the invariant above.
2. **verify** — calls `verify.yml` (the same reusable workflow a pull request runs) as a reusable
   workflow. A release must never publish an image that hasn't passed the exact same checks a PR has
   to pass.
3. **build** — a matrix of `{linux/amd64 on ubuntu-24.04}` / `{linux/arm64 on ubuntu-24.04-arm}`,
   each a **native** runner (no QEMU emulation — see "Native arm64 runners" below). Each pushes its
   single-platform image **to GHCR only**, by digest (`push-by-digest=true`, no tag at this stage at
   all), and uploads that digest as a build artifact.
4. **merge** — downloads both digests, then runs one `docker buildx imagetools create` that
   assembles them into a single multi-arch manifest list and pushes it, under every real tag this
   release gets, to **all three** registries. See "Fan-out at merge, not per-arch build" below for
   why the per-arch build only ever touches GHCR.
5. **release** — `gh release create --verify-tag`, only after `merge` has succeeded. Adds
   `--prerelease` for a prerelease version, `--latest` otherwise. Never creates the tag itself
   (`--verify-tag` refuses to run if the tag isn't already there) and never runs before the images
   are confirmed live.

## Design decisions

### Gate = full `npm run verify`, not a cheaper subset

`verify.yml` runs all five steps from [`AGENTS.md`](../../AGENTS.md)'s definition of done, e2e
included, for both pull requests and releases. The obvious worry — GitHub Actions' free-tier minute
quota — doesn't apply here: this repository is **public**, and GitHub Actions minutes on public
repos (standard _and_ arm64 runners) are free and unmetered; the 2,000 min/month Free-plan cap only
applies to private repos. There's no cost pressure to gate on anything less than the real thing.

The e2e suites need a real ImageMagick `>= 7`
([`docs/platform-setup.md`](../platform-setup.md#external-media-tools)), but `ubuntu-24.04`'s own
apt-installable ImageMagick is 6. So `verify.yml` runs `npm run verify` inside a `node:22-trixie`
container (the same Debian release the production `Dockerfile` is built on, which does carry
ImageMagick 7.1.1) rather than on the bare runner. That container needs `--network host`: the e2e
suite's own [`LocalStack helper`](../../test/e2e/helpers/localstack.ts) starts LocalStack as a
_sibling_ container (via the host's docker socket, bind-mounted in) and connects to it at
`http://localhost:<port>`. A sibling container's published port lands in the **host's** network
namespace, not the trixie container's own private one — `--network host` is what makes "localhost"
resolve to the same place in both.

### Native arm64 runners, not QEMU

`docs/platform-setup.md#multi-platform-arm64` already measured QEMU-emulated cross-builds as
meaningfully slower (`apt-get install` alone ran several minutes longer emulated). GitHub's
`ubuntu-24.04-arm` runners build arm64 natively, at the same speed as the amd64 job, for the same
price (free on a public repo) — so the matrix in `build` just runs each architecture on the runner
that's actually that architecture, with no QEMU/binfmt setup at all.

### Fan-out at merge, not per-arch build

A naive matrix would log every `build` job into all three registries and push its single-architecture
image to each of them directly. Instead, `build` logs into **GHCR only**. The `merge` job then runs:

```bash
docker buildx imagetools create -t <tag1> -t <tag2> ... \
  ghcr.io/<repo>@sha256:<amd64-digest> ghcr.io/<repo>@sha256:<arm64-digest>
```

`imagetools create`'s `-t` targets don't have to live in the same registry as its source references
— it copies whatever blobs a destination registry doesn't already have, the same mechanism a
registry-mirroring tool would use. So one invocation, reading two digests that exist only in GHCR,
can push the assembled manifest list straight to Docker Hub's and ECR Public's own tags too. Net
effect: 2 registry logins in `build` → 1 (GHCR), and the Docker Hub/ECR Public credentials only ever
need to exist in one job (`merge`) instead of being duplicated across the matrix.

It also sidesteps a sharper problem: pushing a _tag_ (as opposed to pushing _by digest_) separately
from each matrix job would leave that tag pointing at a single-platform image for however long it
takes the other architecture's job to finish — a real, if narrow, window where `docker pull
sync1:1.2.3` on arm64 could fail or silently receive the wrong platform. Tags are only ever applied
once, by `merge`, to the manifest list — no tag exists anywhere before both architectures are
already assembled into one.

### Tag computation is hand-rolled, not `docker/metadata-action`

Given a version `X.Y.Z`, every registry gets `:X.Y.Z` and `:X.Y`. A bare `:X` is added too, but only
once `X > 0` — `:0` reads as meaningless (or actively misleading) for a pre-1.0 package, whereas
`:1`, `:2`, ... become genuinely useful floating tags once a major version 1+ actually exists.
`:latest` is added only when the version carries no prerelease suffix, so a bare `docker pull
<image>` can never resolve to an `-rc`/`-beta` build. `docker/metadata-action`'s semver pattern
engine doesn't have a "skip the bare major tag below 1.0" rule built in, and fighting its heuristics
for one non-standard rule seemed less clear than just computing the four-or-fewer tag strings
directly in `bash` from `check-version`'s already-parsed `version`/`prerelease` outputs — which is
also then trivially reused to build the `-t ... -t ...` argument list for every one of the three
registries in a single loop.

### ECR Public + OIDC, not access keys

The image is public either way it's pulled, so ECR Public (not a private ECR repository) is the
natural fit — same free, world-pullable model as GHCR and Docker Hub. Authentication is a GitHub
OIDC token exchanged for a short-lived AWS role (`aws-actions/configure-aws-credentials` +
`aws-actions/amazon-ecr-login`), not a long-lived `AWS_ACCESS_KEY_ID`/`SECRET` pair sitting in repo
secrets indefinitely. ECR Public's own control-plane API exists only in `us-east-1` regardless of
where the pulling clients are, which is why `merge` always configures that region explicitly.

## One-time setup (per registry)

None of this is automated — it's done once, by hand, before the first real release.

**Docker Hub** — create the `sync1` repository, and an access token with read/write scope. Store:

- Repo secret `DOCKERHUB_USERNAME`
- Repo secret `DOCKERHUB_TOKEN` (the access token, not your account password)
- Repo variable `DOCKERHUB_REPO` — the full `<your-dockerhub-username>/sync1` path

**ECR Public** (console/CLI calls below all target `us-east-1`):

```bash
aws ecr-public create-repository --repository-name sync1 --region us-east-1
```

Note the registry alias this prints — store it as repo variable `ECR_PUBLIC_ALIAS`. Then, one-time
IAM setup for OIDC:

1. Add an IAM OIDC identity provider for `token.actions.githubusercontent.com` (audience
   `sts.amazonaws.com`), if this AWS account doesn't already have one from another repo.
2. Create an IAM role whose trust policy's `sub` condition is
   `repo:<owner>/sync1:ref:refs/tags/v*` — scoped to tag pushes only, so nothing else in this
   repository's CI can assume it.
3. Grant that role: `ecr-public:GetAuthorizationToken`, `sts:GetServiceBearerToken` (both
   account-wide, ECR Public has no per-repository ARN for these two), and
   `ecr-public:BatchCheckLayerAvailability`, `ecr-public:InitiateLayerUpload`,
   `ecr-public:UploadLayerPart`, `ecr-public:CompleteLayerUpload`, `ecr-public:PutImage` scoped to
   the `sync1` repository's own ARN.
4. Store the role's ARN as repo variable `AWS_ROLE_ARN`.

**GHCR** — nothing to configure beforehand; `release.yml` authenticates with the workflow's own
`GITHUB_TOKEN`. After the very first push, GHCR packages start **private** by default — go to the
package's own settings once and set it to public, and link it to this repository (so it shows up on
the repo's sidebar).

## Known sharp edge: apt pins going stale

The `Dockerfile` pins exact Debian apt package versions for `ffmpeg`/`imagemagick` (see its own
header comment for the full rationale) — intentional, so a stale pin fails the build loudly instead
of silently drifting. The cost is that a routine Debian trixie security update can break `docker
build` with no release anywhere near it — the first sign would otherwise be a release failing in the
`build` job, mid-release.

**`docker-canary.yml`** runs the same build (amd64 only, no push) every Monday and on manual dispatch,
purely to catch that early. On failure, it opens (or comments on an already-open) issue titled
"Dockerfile apt pins stale", linking the failed run.

**Fix procedure**, once that issue appears:

1. `./scripts/print-apt-pins.sh` — prints the current `apt-cache policy` candidate versions for
   `imagemagick`/`ffmpeg` inside the exact pinned base image (`ARG NODE_IMAGE` in the `Dockerfile`).
2. Bump `ARG IMAGEMAGICK_VERSION` / `ARG FFMPEG_VERSION` in the `Dockerfile` to match.
3. Validate the image itself — `npm run verify`'s e2e suites can't catch this: they run inside
   `verify.yml`'s own `node:22-trixie` container with _unpinned_ `apt-get install imagemagick ffmpeg`
   (the very "whatever's current" versions this procedure is pinning the production image to), so
   they're already green regardless of whether the `Dockerfile`'s own pins are stale. Actually build
   it instead: `docker build .` (its own `RUN` step already asserts `ImageMagick 7.` and that
   `ffmpeg`/`ffprobe` run), plus a real smoke run — `docker run --rm <image> thumbnail ensure
--root ...` against a small test vault, or at minimum `identify`/`ffprobe` against a fixture
   file inside the built image.
4. Open a PR with the bump (runs `verify.yml` as usual), merge it, then cut a **new** patch release
   (`npm version patch`). Never move, delete, or re-push the tag that failed — it correctly points at
   a commit whose pins were stale; the fix belongs in a new commit and a new tag.

(Rejected alternative: point `apt-get` at a fixed `snapshot.debian.org` date instead of the live
mirror. That would never break, but would also silently stop receiving security fixes for
`ffmpeg`/`imagemagick` until someone remembered to bump the snapshot date by hand — worse than a
loud, immediate failure.)
