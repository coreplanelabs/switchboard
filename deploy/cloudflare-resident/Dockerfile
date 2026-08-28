# Resident container image: the @cloudflare/sandbox base (Ubuntu 22.04; already
# ships git, curl, jq, Node 24, npm, bun, cloudflared) plus GitHub tooling and
# a pool of unprivileged users.
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

# pnpm: the base ships Node 24 + npm + bun but not pnpm, so a pnpm repo can't be
# provisioned (install → build) when onboarded. corepack is NOT on this base's
# PATH (unlike the older sandbox base), so install pnpm via npm at build time —
# this bakes pnpm into the image so it's ready offline when a worktree provisions.
RUN npm install -g pnpm@latest

# KTD5: agent commands never run as root. The SDK's exec has no user/uid option
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
