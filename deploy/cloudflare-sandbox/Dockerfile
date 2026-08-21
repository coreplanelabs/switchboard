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
