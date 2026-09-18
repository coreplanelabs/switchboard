# Sandbox container image: the @cloudflare/sandbox base plus git + gh, a Docker
# engine, Node 24 with pnpm and a pinned bun, and the toolchain a run builds
# and looks with (compilers, ffmpeg, a headless Chromium), so the
# coding/review/explore agents work out of the box.

# The Node this image ships (copied in below), at the exact tag every image in
# this repository shares — its major is .nvmrc's, which is what CI runs and
# the install script requires. `--platform`: the cloudflare/sandbox base below
# publishes linux/amd64 only, so the stage the binary is copied from must be
# amd64 too — a bare FROM on an arm64 host resolves it to arm64 and the copied
# binary cannot run in the base (check:image on Apple silicon failed exactly
# so). src/deploy/imageNode.test.ts holds the tag, its major and the platform.
FROM --platform=linux/amd64 docker.io/library/node:24.21.0-slim AS node

# The tag MUST match the @cloudflare/sandbox version in package.json exactly
# (no 'latest' tag exists on the @next line) — bump both together. The same
# base as the resident image: its container server is compiled with a Bun
# whose directory watcher no longer dies on an entry removed under it, which
# ended the 0.12.9 line's server mid-command (docs/reference/specs/execution.md
# item 21).
FROM docker.io/cloudflare/sandbox:0.13.0-next.751.1
USER root
# The SDK's container server kills any command after COMMAND_TIMEOUT_MS
# (unset → no limit). Pure BACKSTOP behind two closer ones: the real
# per-command limit is coreutils `timeout` in worker.ts (280s default,
# raisable per call via the bash tool's timeoutMs up to the 20-min ceiling
# BASH_TIMEOUT_MAX_MS), which yields a genuine exit 124 through the normal
# result path, and worker.ts launches each process with the SDK's own
# per-process `timeout` a margin above that. This sits 40s above the 20-min
# ceiling so it never wins the race. Bump alongside BASH_TIMEOUT_MAX_MS
# (src/execution/bashTimeout.ts); changing it requires a container rebuild +
# redeploy.
ENV COMMAND_TIMEOUT_MS=1240000
# One Node process may take 8 GiB of the 12 for its heap. V8's own default is
# a quarter of physical memory (~3 GiB on this instance), which would refuse
# the very command the instance size was chosen for — a large monorepo's
# typecheck near 8 GB (docs/reference/specs/execution.md item 16) — while the
# box sat three-quarters empty. The same cap as the resident image's;
# src/deploy/imageNode.test.ts holds the two equal.
ENV NODE_OPTIONS=--max-old-space-size=8192
# docker.io + iptables: a Docker engine for runs whose tests need containers
# (act's default job mode, testcontainers, compose, image builds). Nothing
# starts the daemon at boot — the wrapper below does, on the first `docker`
# call. The sandbox is already root with full capabilities inside its own
# microVM, so a container a run starts shares that run's blast radius and
# nothing more; no privileged flag or capability is added anywhere.
# squashfs-tools (`unsquashfs`): the seed (docs/reference/specs/execution.md
# item 25) restores the resident's snapshot with the SDK's presigned restore,
# which MOUNTS the archive (squashfuse + fuse-overlayfs) instead of extracting
# it; the Worker extracts it onto the disk the way the resident does
# (resident-repos item 61) so the checkout is one plain ext4 tree. The build
# asserts the binary with the probe the extract script uses (`command -v`).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates docker.io iptables squashfs-tools \
  && command -v unsquashfs >/dev/null \
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

# Node 24, not the base's. The 0.13.0-next base ships Node 22.23.2 like the
# 0.12.9 one (copied from node:22-slim: the binary at /usr/local/bin/node, npm and
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

# pnpm + bun: the base image ships Node + npm (corepack is under
# /usr/local/lib/node_modules but not on PATH) and not pnpm, so coding runs in pnpm repos hit
# `pnpm: command not found` on install/build. Installed globally with npm, the
# same way the resident image does it, so this version is here before any run
# needs it. It is not necessarily the version that RUNS: pnpm ≥10 honours a
# repo's own `packageManager` field and fetches it, so a pnpm repo that pins
# one still needs the registry on its first install.
#
# EXACT versions, enforced by src/deploy/imagePins.test.ts, same pins and same
# reasons as the resident image (deploy/cloudflare-resident/Dockerfile): with
# `@latest` here the pnpm major moved on a rebuild, and pnpm 11 stopped
# reading `package.json`'s `pnpm` field. pnpm still honours a repo's own
# `packageManager`, so this is the floor for repos that name none. bun does
# NOT honour it: the version baked here is the one a repo's `bun install`
# runs, and the base's own bun — a real binary at /usr/local/bin/bun, 1.3.12
# on this base, measured — rejects a `bun.lock` at lockfileVersion 3 as
# "Unknown lockfile version" (bun 1.4 stamps v3 when `overrides` carry scoped
# `name@range` rules), so a coding run in such a repo fails its install
# exactly as the resident's attach did. The pin must therefore sit at
# or above what any repo we run pins, and it moves by a commit, not a base
# bump. The base's binary is removed first (npm will not write its `bun` link
# over a file it does not own; the container server at
# /container-server/sandbox is a standalone bun-compiled executable and does
# not run through it), bun's postinstall is allowed by name (the npm package
# is a placeholder until that script moves the real binary in from the
# platform optional dependency, and npm's global installs are growing an
# `allow-scripts` allowlist for install scripts), the grep proves the bun on
# PATH is the pin, and the npm cache (bun's tarball is large) is dropped in
# the same layer.
RUN rm -f /usr/local/bin/bun \
  && npm install -g --allow-scripts=bun pnpm@10.34.5 bun@1.4.2 \
  && npm cache clean --force \
  && pnpm --version | grep -qx '10\.34\.5' \
  && bun --version | grep -qx '1\.4\.2'

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

# pi — the coding harness the bot can start INSIDE this container in place of
# its native turn loop (docs/reference/specs/harness-pi.md): `pi --mode rpc`,
# one process per run in the thread's worktree, driven by the bot over its
# JSONL protocol, with the run's model-proxy bearer as its only key (never a
# model key: the bearer buys calls through the bot, docs/reference/specs/
# model-proxy.md). Installed globally with this image's Node — pi needs
# >= 22.19.0 and the image ships 24 — so every user finds it on PATH, at an
# EXACT pin held by src/deploy/imagePiHarness.test.ts (the pnpm lesson: a
# floating tag would move the harness's protocol with the build date, and a
# pi minor changes RPC events and extension hooks). Proven by the layer, so
# the BUILD fails, not a run: the pi on PATH answers the pin, and its own help
# names the RPC mode the harness drives. Dark until a deployment sets
# `harness: { coding: pi }`: nothing here starts pi on its own.
RUN npm install -g @earendil-works/pi-coding-agent@0.85.1 \
  && npm cache clean --force \
  && pi --version | grep -qx '0.85.1' \
  && pi --help | grep -q -- '--mode <mode>'

# OpenCode, the second harness (docs/reference/specs/harness.md): `@opencode/cli`
# at the EXACT pin held by src/deploy/imageOpenCodeHarness.test.ts, beside pi.
# The wrapper's postinstall hard-links the platform binary into place, so it
# is the one install script allowed by name; the grep proves the binary on
# PATH prints the pin's version text (`opencode v2.0.3`, exactly); the npm
# cache (a 200 MB tarball) is dropped in the same layer. Dark until a
# deployment names it: nothing here starts it on its own.
RUN npm install -g --allow-scripts=@opencode/cli @opencode/cli@2.0.3 \
  && npm cache clean --force \
  && opencode --version | grep -qx 'opencode v2.0.3'

# The container outlives a crash of the SDK's container server (the
# supervisor's header says why). The base image's ENTRYPOINT is tini running
# the server, so one uncaught exception there ended the container; here tini
# stays PID 1 — it reaps orphans and forwards the platform's signals — and
# runs the supervisor, which starts the server again when it exits.
# src/deploy/sandboxRuntimeSupervisor.test.ts holds this pair of lines.
# The .mjs extension keeps Node reading it as ESM; its `#!/usr/bin/env node`
# resolves to the Node copied in above.
COPY --chmod=0755 runtime-supervisor.mjs /usr/local/bin/sandbox-runtime-supervisor.mjs
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sandbox-runtime-supervisor.mjs"]
