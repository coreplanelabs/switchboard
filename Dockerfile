# Switchboard — single-process Slack bot (Socket Mode, no inbound port needed).
# git + gh are installed because the coding/review agents shell out to them.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Non-root user; agents run bash with this user's (container-scoped) permissions.
RUN useradd -m -u 1001 switchboard
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# build.json is written by deploy/cloudflare/write-build.mjs (npm run deploy) and
# served on /healthz as `build`; the glob keeps it optional so a bare
# `wrangler deploy` / docker compose still builds (the bot then says "unknown").
COPY package.json build.jso[n] ./
# config.yaml is expected at /app/config/config.yaml — bake it in or mount it.
COPY config ./config
# Bundled skills (#100): loaded at startup by BundledSkillStore from /app/skills.
COPY skills ./skills
RUN mkdir -p /app/data /app/workspaces && chown -R switchboard:switchboard /app
USER switchboard

# gh auth: set GH_TOKEN (fine-grained PAT for a machine account); gh and git
# (via gh's credential helper, configured below) pick it up automatically.
RUN git config --global credential.helper '!gh auth git-credential' \
  && git config --global user.name "switchboard-bot" \
  && git config --global user.email "switchboard-bot@users.noreply.github.com"

ENV NODE_ENV=production
# PORT enables the /healthz-style probe endpoint (any path returns 200).
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
