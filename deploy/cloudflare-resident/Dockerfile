# Resident container image: the @cloudflare/sandbox base (Ubuntu 22.04; already
# ships git, curl, jq, Node 24, npm, bun, cloudflared) plus GitHub tooling and
# a pool of unprivileged users.
# The tag MUST match the @cloudflare/sandbox version in package.json exactly
# (no 'latest' tag exists on the @next line) — bump both together.
FROM docker.io/cloudflare/sandbox:0.13.0-next.751.1

# gh CLI + git identity, mirroring the thread-sandbox image: agents talk to
# GitHub with a short-lived App installation token injected per command (never
# baked into the image).
RUN apt-get update \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system credential.helper '!gh auth git-credential' \
  && git config --system user.name "switchboard-resident" \
  && git config --system user.email "switchboard-resident@users.noreply.github.com"

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
    for i in 1 2 3 4 5 6 7 8; do useradd -m -u "$((2000 + i))" -s /bin/bash "worker$i"; done; \
    if dpkg -s sudo >/dev/null 2>&1; then apt-get remove -y --purge sudo; fi; \
    passwd -l root
