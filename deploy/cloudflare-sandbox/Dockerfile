# Sandbox container image: the @cloudflare/sandbox base plus git + gh, so the
# coding/review agents work out of the box.
# The tag MUST match the @cloudflare/sandbox version in package.json exactly
# (no 'latest' tag exists) — bump both together.
FROM docker.io/cloudflare/sandbox:0.3.7
USER root
# The SDK's container server kills any command after COMMAND_TIMEOUT_MS
# (default 30s) — far too short for clones, installs, and test runs. exec()
# in 0.3.x ignores per-call timeouts, so this env var is the only lever.
# Pure BACKSTOP: the real per-command limit is coreutils `timeout` at
# EXEC_TIMEOUT_SECS (280s) in worker.ts, which yields a genuine exit 124
# through the normal result path. This sits 40s above so it never wins the
# race (the SDK's rejection surfaces only a useless generic error). Bump the
# two together.
ENV COMMAND_TIMEOUT_MS=320000
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system credential.helper '!gh auth git-credential' \
  && git config --system user.name "switchboard-bot" \
  && git config --system user.email "switchboard-bot@users.noreply.github.com"

# Node 22: the base image ships Node 20 (NodeSource `nodejs` deb, with the
# NodeSource keyring + node_20.x apt list already in place), but this repo pins
# `engines: node >=22` (undici@8 needs Node 22's `webidl.util.markAsUncloneable`),
# so a review run that falls back off the resident onto a fresh sandbox
# couldn't even LOAD 15 vitest suites (#372). The resident image gets Node 24
# from its newer base; here the base tag is pinned to the 0.3.x SDK, so instead
# retarget the base's own NodeSource apt list at the Node 22 repo and upgrade
# the same `nodejs` package (npm + corepack ride along with the deb). Must run
# BEFORE the corepack/pnpm step below so pnpm is prepared by the final Node.
# The greps assert the retarget and the upgrade took, failing the build
# otherwise (e.g. if a base bump moves the list file or Node lands below 22).
RUN sed -i 's|node_20\.x|node_22.x|' /etc/apt/sources.list.d/nodesource.list \
  && grep -q 'node_22\.x' /etc/apt/sources.list.d/nodesource.list \
  && apt-get update && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/* \
  && node --version | grep -q '^v22\.'

# pnpm: the base image ships Node/npm/corepack but not pnpm, so coding runs in
# pnpm repos hit `pnpm: command not found` on install/build. corepack ships with
# the base Node (no apt package needed); `prepare` fetches and pins pnpm at
# build time so it's baked into the image and ready offline at run time.
RUN corepack enable && corepack prepare pnpm@latest --activate
