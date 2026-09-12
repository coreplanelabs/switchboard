# Sandbox container image: the @cloudflare/sandbox base plus git + gh, a Docker
# engine, Node 24 with pnpm, and the toolchain a run builds and looks with
# (compilers, ffmpeg, a headless Chromium), so the coding/review/explore
# agents work out of the box.

# The Node this image ships (copied in below), at the exact tag every image in
# this repository shares — its major is .nvmrc's, which is what CI runs and
# the install script requires. `--platform`: the cloudflare/sandbox base below
# publishes linux/amd64 only, so the stage the binary is copied from must be
# amd64 too — a bare FROM on an arm64 host resolves it to arm64 and the copied
# binary cannot run in the base (check:image on Apple silicon failed exactly
# so). src/deploy/imageNode.test.ts holds the tag, its major and the platform.
FROM --platform=linux/amd64 docker.io/library/node:24.21.0-slim AS node

# The tag MUST match the @cloudflare/sandbox version in package.json exactly
# (no 'latest' tag exists) — bump both together.
FROM docker.io/cloudflare/sandbox:0.12.9
USER root
# The SDK's container server kills any command after COMMAND_TIMEOUT_MS. On
# 0.12.x the default is unlimited (unset → no limit; 0.3.x defaulted to 30s),
# a per-exec `timeout` option wins over it, and a kill by it lands as a normal
# result with a synthetic exit code (143/137), not a rejection. worker.ts
# passes no per-call timeout, so this env var is the container-level lever.
# Pure BACKSTOP: the real per-command limit is coreutils `timeout` in
# worker.ts (280s default, raisable per call via the bash tool's timeoutMs up
# to the 20-min ceiling BASH_TIMEOUT_MAX_MS), which yields a genuine exit 124
# through the normal result path. This sits 40s above the 20-min ceiling so it
# never wins the race. Bump alongside BASH_TIMEOUT_MAX_MS
# (src/execution/bashTimeout.ts); changing it requires a container rebuild +
# redeploy.
ENV COMMAND_TIMEOUT_MS=1240000
# docker.io + iptables: a Docker engine for runs whose tests need containers
# (act's default job mode, testcontainers, compose, image builds). Nothing
# starts the daemon at boot — the wrapper below does, on the first `docker`
# call. The sandbox is already root with full capabilities inside its own
# microVM, so a container a run starts shares that run's blast radius and
# nothing more; no privileged flag or capability is added anywhere.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates docker.io iptables \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system credential.helper '!gh auth git-credential' \
  && git config --system user.name "switchboard-bot" \
  && git config --system user.email "switchboard-bot@users.noreply.github.com"

# `docker` resolves to this wrapper (/usr/local/bin precedes /usr/bin on PATH):
# it starts dockerd in its own session on first use — a plain background
# process would die with the exec's process group — waits for the engine, then
# execs the real client. src/deploy/sandboxDocker.test.ts holds its shape.
COPY --chmod=0755 docker-wrapper.sh /usr/local/bin/docker

# Node 24, not the base's. The published 0.12.9 base ships Node 22.23.2
# (copied from node:22-slim: the binary at /usr/local/bin/node, npm and
# corepack under /usr/local/lib/node_modules, npm/npx symlinked into it), while
# this repository builds and tests on Node 24 (.nvmrc, CI) and its published
# CLI requires `>=24`. A run that exercised the suite inside this image read a
# different `verify` than CI did: `npm ci` warned on the CLI package's engines,
# and tests that pass in CI failed here. So Node comes from the official image
# at an exact tag, in the `node` stage above: the base's npm tree is removed
# first (no file of npm 10 survives under npm 11), then the binary, npm's tree
# and the headers (node-gyp compiles native addons against them without a
# download) land at the base's own paths, so its npm/npx symlinks keep
# resolving. The container server (/container-server/sandbox, a bun-compiled
# binary) does not run on this Node, so only what a run's commands see moves.
# The grep fails the BUILD, not a run, if a bump ever lands another version
# here; src/deploy/imageNode.test.ts holds it equal to the stage's tag.
RUN rm -rf /usr/local/lib/node_modules /usr/local/include/node
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node /usr/local/include/node /usr/local/include/node
RUN node --version | grep -qx 'v24.21.0' \
  && npm --version >/dev/null \
  && npx --version >/dev/null

# pnpm: the base image ships Node + npm (corepack is under
# /usr/local/lib/node_modules but not on PATH) and not pnpm, so coding runs in pnpm repos hit
# `pnpm: command not found` on install/build. Installed globally with npm, the
# same way the resident image does it, so this version is here before any run
# needs it. It is not necessarily the version that RUNS: pnpm ≥10 honours a
# repo's own `packageManager` field and fetches it, so a pnpm repo that pins
# one still needs the registry on its first install.
#
# EXACT version, enforced by src/deploy/imagePins.test.ts, same pin and same
# reason as the resident image (deploy/cloudflare-resident/Dockerfile): with
# `@latest` here the pnpm major moved on a rebuild, and pnpm 11 stopped
# reading `package.json`'s `pnpm` field. pnpm still honours a repo's own
# `packageManager`, so this is the floor for repos that name none.
RUN npm install -g pnpm@10.34.5 \
  && pnpm --version | grep -qx '10\.34\.5'

# The toolchain for what a run BUILDS and LOOKS AT — the same layer as the
# resident image's (deploy/cloudflare-resident/Dockerfile);
# src/deploy/imageToolchain.test.ts holds the two to one shape.
#   - python3 + make + g++: node-gyp's needs. A cold `npm install` in a repo
#     with a native module (node-pty) rebuilds it from source, and died here
#     on "no Python". Just the three — no build-essential, no recommends.
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
#     (a+rX): the resident runs each agent command as an unprivileged
#     workerN, and the two images share this layer. NODE_PATH makes
#     `require('playwright')` resolve from any working directory. Playwright
#     launches Chromium with --no-sandbox (`chromiumSandbox: false`, its
#     default) — what a root process, or one without user namespaces, needs.
# Every claim is PROVEN by the layer itself, so the BUILD fails, not a run:
# the compilers answer --version, ffmpeg encodes a one-second testsrc clip to
# h264 and decodes a non-empty frame back out of it, the playwright CLI is on
# PATH at the pin, and a real headless screenshot of a page lands as a
# non-empty png. The proof artefacts, the apt lists, apt's .deb archive (this
# base has no docker-clean hook: 400 MB of archives stayed behind without the
# `clean`) and npm's cache go in the same layer.
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
