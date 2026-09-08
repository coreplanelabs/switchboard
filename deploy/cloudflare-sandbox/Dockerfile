# Sandbox container image: the @cloudflare/sandbox base plus git + gh, so the
# coding/review agents work out of the box.
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

# Node comes from the base: the published 0.12.9 image ships Node 22.23 (copied
# from node:22-slim, with npm; no NodeSource deb), so the retarget-and-upgrade
# layer the 0.3.x image needed is gone. This repo pins `engines: node
# >=22` (undici@8 needs Node 22's `webidl.util.markAsUncloneable`), and a
# review run that falls back off the resident onto a fresh sandbox must load
# the full vitest suite; the assertion fails the build if a base bump ever
# lands below 22. (The resident image gets Node 24 from its 0.13.0-next base.)
RUN node --version | grep -Eq '^v(2[2-9]|[3-9][0-9])\.'

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
