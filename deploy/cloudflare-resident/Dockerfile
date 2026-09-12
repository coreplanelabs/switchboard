# Resident container image: the @cloudflare/sandbox base (Ubuntu 22.04; already
# ships git, curl, jq, npm, bun, cloudflared and a Node 22 this image replaces
# with Node 24 below) plus GitHub tooling and a pool of unprivileged users.

# The Node this image ships (copied in below), at the exact tag every image in
# this repository shares — its major is .nvmrc's, which is what CI runs and
# the install script requires. `--platform`: the cloudflare/sandbox base below
# publishes linux/amd64 only, so the stage the binary is copied from must be
# amd64 too — a bare FROM on an arm64 host resolves it to arm64 and the copied
# binary cannot run in the base (check:image on Apple silicon failed exactly
# so). src/deploy/imageNode.test.ts holds the tag, its major and the platform.
FROM --platform=linux/amd64 docker.io/library/node:24.21.0-slim AS node

# The tag MUST match the @cloudflare/sandbox version in package.json exactly
# (no 'latest' tag exists on the @next line) — bump both together.
FROM docker.io/cloudflare/sandbox:0.13.0-next.751.1

# Git identity only. The engine never uses the gh CLI (ops run git directly,
# tokens are minted via the GitHub REST API in the Worker/DO, and per-attach
# credentials use a repo-local `store` helper), so gh is deliberately NOT
# installed here — matching the resident system prompts and the tests that pin
# that claim. No system credential.helper is configured; each worktree sets its
# own per-attach helper.
RUN git config --system user.name "switchboard-resident" \
  && git config --system user.email "switchboard-resident@users.noreply.github.com"

# The container is FOUR vCPUs shared by up to 16 threads (wrangler.jsonc).
# Node test runners size their worker pools from the CPU count the kernel
# reports — the HOST's, not the cgroup's — so an unconfigured `vitest`/`jest`
# run forks a dozen workers and thrashes (seen live on the 1 vCPU resident: a
# resident pinned at 100% CPU, 2.2 GiB). The runner pins stay at ONE worker per
# thread: the cores are for concurrent threads, not for one thread's test
# parallelism, and a repo's own config or CLI flags still win. The libuv pool
# is one thread per vCPU (it is per Node process; more would oversubscribe the
# cores once several threads run). These defaults inherit into every thread's
# `su … -c` shell (su without `-` keeps the environment). CI=1 makes runners
# non-interactive (no watch mode, no TTY progress spinners in captured
# output). The heap cap keeps one runaway process to an eighth of the 12 GiB
# so its neighbours keep theirs.
ENV CI=1 \
    VITEST_MAX_WORKERS=1 VITEST_MAX_THREADS=1 VITEST_MAX_FORKS=1 VITEST_MIN_THREADS=1 VITEST_MIN_FORKS=1 \
    UV_THREADPOOL_SIZE=4 \
    NODE_OPTIONS=--max-old-space-size=1536

# Node 24, not the base's. The 0.13.0-next base ships Node 22.23.2 like the
# 0.12.9 one (copied from node:22-slim: the binary at /usr/local/bin/node, npm
# and corepack under /usr/local/lib/node_modules, npm/npx symlinked into it),
# while this repository builds and tests on Node 24 (.nvmrc, CI) and its
# published CLI requires `>=24` — so a repository validated here read a
# different `verify` than CI did. Node comes from the official image at an
# exact tag, in the `node` stage above, the same way the sandbox image does it
# (deploy/cloudflare-sandbox/Dockerfile): the base's npm tree removed first,
# then the binary, npm's tree and the headers at the base's own paths, so its
# npm/npx symlinks keep resolving; the container server is a bun-compiled
# binary and does not run on this Node. The grep fails the BUILD if a bump
# lands another version; src/deploy/imageNode.test.ts holds it equal to the
# stage's tag. This layer sits before the package managers below so they are
# installed by this Node's npm, into this tree.
RUN rm -rf /usr/local/lib/node_modules /usr/local/include/node
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node /usr/local/include/node /usr/local/include/node
RUN node --version | grep -qx 'v24.21.0' \
  && npm --version >/dev/null \
  && npx --version >/dev/null

# pnpm + yarn: the base ships npm + bun but neither pnpm nor yarn, so a
# repo whose onboard table is detected as pnpm or yarn (resident-repos item 52 —
# every manager `detectCommands` can emit must exist here, or the table fails
# deterministically at provision) couldn't be provisioned (install → build).
# corepack is NOT on this base's PATH (unlike the older sandbox base), so both
# come from npm at build time. yarn here is classic (1.x); a Yarn Berry repo
# bootstraps through it via the `yarnPath` release it commits under
# `.yarn/releases`.
#
# EXACT versions, enforced by src/deploy/imagePins.test.ts. This line once read
# `pnpm@latest yarn@latest`, which made the pnpm major a property of the last
# image build: one rebuild moved it 10 -> 11 unannounced, and pnpm 11 no
# longer reads `package.json`'s `pnpm` field (overrides,
# patchedDependencies, onlyBuiltDependencies), so a repo keeping its settings
# there fails `--frozen-lockfile` with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
# pnpm is pinned to the 10 line ON PURPOSE: 10.x reads that field, and pnpm
# >=10 self-manages `packageManager`, so a repo pinning 11/12 still gets its
# own version — the pin is a floor, not a ceiling. Which means the version
# baked here is NOT necessarily the one that runs: a repo with a
# `packageManager` field downloads that version on first install (a repo
# pinning pnpm@10.10.0 gets exactly that), so provisioning needs the registry,
# not just the image. The grep asserts the pin took, so a resolution surprise
# fails the build instead of a provision.
RUN npm install -g pnpm@10.34.5 yarn@1.22.22 \
  && pnpm --version | grep -qx '10\.34\.5' \
  && yarn --version | grep -qx '1\.22\.22'

# squashfs-tools (`unsquashfs`): the SDK's presigned restore does not extract
# an archive, it MOUNTS it (squashfuse + fuse-overlayfs at the handle's dir)
# and leaves the `.sqsh` under /var/backups — resident-repos item 61. The
# resident extracts the archive onto its ext4 disk instead (the SDK's own
# local-dev method) so the mirror, the checkout and the deps store stay one
# filesystem: `rm -rf` works, hardlink views work, `du -x` is right. The
# Worker falls back to `cp -a` out of the mount while an older image lacks it.
# The build asserts the binary with the probe the extract script uses at run
# time (`command -v`): `unsquashfs -version` exits 1 on squashfs-tools 4.5 (this
# base) when no filesystem is named, and failed the 1.2.0 image build that way.
RUN apt-get update \
  && apt-get install -y --no-install-recommends squashfs-tools \
  && rm -rf /var/lib/apt/lists/* \
  && command -v unsquashfs >/dev/null

# The toolchain for what a run BUILDS and LOOKS AT — the same layer as the
# sandbox image's (deploy/cloudflare-sandbox/Dockerfile);
# src/deploy/imageToolchain.test.ts holds the two to one shape.
#   - python3 + make + g++: node-gyp's needs. A cold `npm install` in a repo
#     with a native module (node-pty) rebuilds it from source, and died on
#     "no Python". Just the three — no build-essential, no recommends.
#   - ffmpeg (Ubuntu's, with libx264): an agent pulls frames out of a video
#     to look at it (`ffmpeg -i in.mp4 -vf fps=1 frame_%03d.png`) and encodes
#     video from frames or a screen recording.
#   - a headless Chromium through Playwright at an EXACT pin
#     (src/deploy/imagePins.test.ts): screenshots, PDFs and `recordVideo`.
#     Ubuntu 22.04's apt `chromium` is a snap stub that does not run in a
#     container, so the browser is Playwright's own build — the headless shell
#     only (`--only-shell`: there is no display), with the system libraries it
#     needs (`--with-deps`) and the fonts pages render text with.
#     PLAYWRIGHT_BROWSERS_PATH is set BEFORE the install so the browser lands
#     under /opt, not root's home, and the tree is opened to every user
#     (a+rX): every agent command here runs as an unprivileged workerN (the
#     pool below), through `su` without `-`, which keeps this environment.
#     NODE_PATH makes `require('playwright')` resolve from any working
#     directory. Playwright launches Chromium with --no-sandbox
#     (`chromiumSandbox: false`, its default) — what a process without user
#     namespaces needs, root or not.
# Every claim is PROVEN by the layer itself, so the BUILD fails, not a run:
# the compilers answer --version, ffmpeg encodes a one-second testsrc clip to
# h264 and decodes a non-empty frame back out of it, the playwright CLI is on
# PATH at the pin, and a real headless screenshot of a page lands as a
# non-empty png — here as root; again as worker1 once the pool exists, below.
# The proof artefacts, the apt lists, apt's .deb archive (this base has no
# docker-clean hook: 400 MB of archives stayed behind without the `clean`)
# and npm's cache go in the same layer.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ffmpeg fonts-liberation fonts-noto-color-emoji \
  && npm install -g playwright@1.63.0 \
  && playwright install --with-deps --only-shell chromium \
  && chmod -R a+rX /opt/ms-playwright \
  && apt-get clean && rm -rf /var/lib/apt/lists/* && npm cache clean --force \
  && python3 --version && g++ --version && make --version \
  && ffmpeg -version \
  && ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=duration=1:size=320x240:rate=10 -c:v libx264 -pix_fmt yuv420p /tmp/proof.mp4 \
  && ffmpeg -hide_banner -loglevel error -i /tmp/proof.mp4 -vf fps=1 /tmp/proof_%03d.png && test -s /tmp/proof_001.png \
  && playwright --version | grep -qx 'Version 1.63.0' \
  && playwright screenshot --viewport-size=640,480 'data:text/html,<h1>ok</h1>' /tmp/ok.png && test -s /tmp/ok.png \
  && rm -f /tmp/proof.mp4 /tmp/proof_*.png /tmp/ok.png

# Agent commands never run as root (repo code runs unprivileged, one user per
# thread — docs/reference/specs/resident-repos.md). The SDK's exec has no user/uid option
# (verified against 0.13.0-next.751.1), so the container server itself runs as
# root and per-command demotion is done with `su -s /bin/bash workerN -c ...`
# (verified live: exec via su lands at uid 200N). Provision a pool of
# unprivileged users — one per resident cap slot — and shut the escalation
# paths back up:
#   - sudo: not installed in the base image; purge defensively in case a later
#     base bump adds it.
#   - su back to root: root's password is locked, so workerN -> root fails.
# `su` itself must stay (it is the demotion mechanism, used only by root).
RUN set -eux; \
    for i in $(seq 1 17); do useradd -m -u "$((2000 + i))" -s /bin/bash "worker$i"; chmod 700 "/home/worker$i"; done; \
    if dpkg -s sudo >/dev/null 2>&1; then apt-get remove -y --purge sudo; fi; \
    passwd -l root

# The browser proof once more, as worker1 — exactly how a thread's commands
# run (`su -s /bin/bash workerN -c …`, root's environment kept). The layer
# above proved it as root; this one proves an unprivileged user can read the
# browser tree under /opt and launch it, so the BUILD fails if a chmod or the
# path ever regresses, not a run.
RUN su -s /bin/bash worker1 -c "playwright screenshot --viewport-size=640,480 'data:text/html,<h1>ok</h1>' /tmp/ok.png && test -s /tmp/ok.png && rm -f /tmp/ok.png"
