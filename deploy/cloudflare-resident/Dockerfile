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

# The container is ONE vCPU (wrangler.jsonc). Node test runners size their
# worker pools from the CPU count the kernel reports — the HOST's, not the
# cgroup's — so an unconfigured `vitest`/`jest` run forks a dozen workers onto
# one core and thrashes (2026-08-29: a resident pinned at 100% CPU, 2.2 GiB).
# These defaults inherit into every thread's `su … -c` shell (su without `-`
# keeps the environment) and are the runners' documented env knobs; a repo's
# own config or CLI flags still win. CI=1 makes runners non-interactive (no
# watch mode, no TTY progress spinners in captured output). The heap cap keeps
# one runaway process from taking the whole 4 GiB from its neighbours.
ENV CI=1 \
    VITEST_MAX_WORKERS=1 VITEST_MAX_THREADS=1 VITEST_MAX_FORKS=1 VITEST_MIN_THREADS=1 VITEST_MIN_FORKS=1 \
    UV_THREADPOOL_SIZE=2 \
    NODE_OPTIONS=--max-old-space-size=1536

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
