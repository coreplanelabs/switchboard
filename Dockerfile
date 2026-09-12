# Switchboard — single-process Slack bot (Socket Mode, no inbound port needed).
# git + gh are installed because the coding/review agents shell out to them.

# Node at the exact tag every image in this repository shares (the execution
# images copy theirs from the same one); its major is .nvmrc's, and
# src/deploy/imageNode.test.ts holds both.
FROM node:24.21.0-slim AS build
WORKDIR /app
# One lockfile covers every workspace. npm needs each workspace's manifest on
# disk to resolve the tree, so the manifests are copied before the install;
# only the root and web dependencies are installed here (the Workers' toolchains
# are never part of the image).
COPY package.json package-lock.json ./
COPY web/package.json ./web/
COPY docs/package.json ./docs/
COPY deploy/cloudflare/package.json ./deploy/cloudflare/
COPY deploy/cloudflare-memory/package.json ./deploy/cloudflare-memory/
COPY deploy/cloudflare-resident/package.json ./deploy/cloudflare-resident/
COPY deploy/cloudflare-sandbox/package.json ./deploy/cloudflare-sandbox/
COPY deploy/cloudflare-docs/package.json ./deploy/cloudflare-docs/
COPY packages/switchboard/package.json ./packages/switchboard/
RUN npm ci --include-workspace-root --workspace web
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
# The web app (Vue, served as hashed assets under /assets/*): vite build reads
# the shared pure modules from ../src, so src must be in place first.
RUN npm run build -w web
RUN npm run build

# Runtime dependencies alone: the bot's production dependencies, no dev tools,
# no web toolchain — a clean install rather than a prune, so nothing hoisted
# for the build survives into the image.
FROM node:24.21.0-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/
COPY docs/package.json ./docs/
COPY deploy/cloudflare/package.json ./deploy/cloudflare/
COPY deploy/cloudflare-memory/package.json ./deploy/cloudflare-memory/
COPY deploy/cloudflare-resident/package.json ./deploy/cloudflare-resident/
COPY deploy/cloudflare-sandbox/package.json ./deploy/cloudflare-sandbox/
COPY deploy/cloudflare-docs/package.json ./deploy/cloudflare-docs/
COPY packages/switchboard/package.json ./packages/switchboard/
RUN npm ci --omit=dev --workspaces=false --include-workspace-root

# meat (meat.dev): the abridged "reading diff" a PR review can carry
# (docs/reference/specs/reading-diff.md). It runs HERE, on the bot host, over a
# diff the bot fetches, with the bot's own Anthropic credential — never inside a
# resident or sandbox, which is why neither execution image installs it. A
# static Go binary (CGO off: bookworm-built, runs on this slim base without a
# libc match) from a pinned commit of boldsoftware/meat: the project publishes
# no release assets, and `@latest` would make the binary a property of the
# build date — the pnpm lesson in src/deploy/imagePins.test.ts. Bumping the sha
# is a reviewable commit; src/deploy/botImageMeat.test.ts holds this shape.
FROM docker.io/library/golang:1.27.1-bookworm AS meat
RUN CGO_ENABLED=0 go install meat.dev/cmd/meat@f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3

FROM node:24.21.0-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# The one binary the meat stage built; `meat -h` exits 0 and proves the static
# binary runs on this base (`command -v` is the probe the host runner uses).
COPY --from=meat /go/bin/meat /usr/local/bin/meat
RUN command -v meat >/dev/null && meat -h >/dev/null 2>&1

# Non-root user; agents run bash with this user's (container-scoped) permissions.
RUN useradd -m -u 1001 switchboard
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The built web app: index.ts loads /app/web/dist at startup (manifest + assets).
COPY --from=build /app/web/dist ./web/dist
# build.json is written by deploy/cloudflare/write-build.mjs (npm run deploy) and
# served on /healthz as `build`; the glob keeps it optional so a bare
# `wrangler deploy` / docker compose still builds (the bot then says "unknown").
COPY package.json project.json build.jso[n] ./
# No config in the image: SWITCHBOARD_CONFIG names a file mounted at run time
# (docker compose: ./config → /app/config) or `state://base`, the document
# `deploy config` pushed to the state Worker (what the Cloudflare shim sets).
# The EXAMPLES are not config: `switchboard init` derives an installation's
# `.env` and `config.yaml` from them, so the container can install too.
COPY .env.example ./
COPY config/config.example.yaml ./config/
COPY deploy/profile.example.json ./deploy/
# Which environment variables are credentials: src/secrets.ts reads the manifest at
# startup (src/core/secretsManifest.test.ts holds this line in place).
COPY deploy/secrets.manifest.json ./deploy/
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
# One image, two jobs: no arguments runs the bot (compose, Cloudflare); arguments
# run the CLI (`init`, `ask`, `<group> <verb>`) — see docker-entrypoint.sh.
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/switchboard
ENTRYPOINT ["switchboard"]
