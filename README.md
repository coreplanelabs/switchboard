# Switchboard

A cheap, configurable agent gateway: requests arrive over a **channel** (Slack today; the CLI is a second channel; Discord/Teams/HTTP are adapters away), get routed to an **agent** (coding, review, general), which runs on a **pluggable inference provider** and executes its tools through a **pluggable executor** (local or per-thread micro-VM). Replaces/subsumes a plain "Claude in Slack" bot with per-channel, per-user, and per-request configuration.

Every boundary is a swappable seam, same pattern at each one:

| Seam | Interface | Implementations | Adding one |
|---|---|---|---|
| Channel | `ChannelIO` + `IncomingMessage` (`src/core/types.ts`) | Slack (Bolt/Socket Mode), CLI | one adapter file in `src/channels/` |
| Provider | `Provider` (`src/providers/types.ts`) | Anthropic, OpenAI-compatible (OpenAI/Groq/Ollama/vLLM = config-only) | one adapter file, or just config |
| Executor | `Executor` (`src/execution/executor.ts`) | local host, E2B micro-VM, Cloudflare Sandbox (via `deploy/cloudflare-sandbox/` proxy Worker) | one backend file + config |
| Agent | `AgentDef` data (`src/agents/registry.ts`) | general, coding, review | one registry entry |

The **core dispatcher** (`src/core/dispatcher.ts`) is the only place orchestration lives: config commands, directive parsing, layered resolution, permission gates, history assembly, the agent run. Channels are pure transports; the dispatcher never imports a platform SDK.

## Agents

| Agent | What it does | Tools |
|---|---|---|
| `general` | Default fallback — plain passthrough to the configured model | none |
| `coding` | Implements a change and ships a PR (clone → branch → edit → test → `gh pr create`) | bash, read, write |
| `review` | Reviews a PR with full-repo context, reports ranked findings | bash, read (read-only by convention) |

Each request runs in a per-thread workspace directory (`workspaces/<channel>-<thread>`), so follow-ups in the same thread reuse the same checkout.

## Configuration layers

Resolution order (highest wins):

1. **Per-request** — inline directives in the message: `agent:review model:openai/gpt-5 look at PR #42`
2. **Per-user** — `config set me model=openai/gpt-5`
3. **Per-channel** — `config set channel agent=review`
4. **Defaults** — `config/config.yaml` (`defaults.agent`, per-agent `defaults.models`)

Runtime overrides persist to `data/overrides.json`. Static defaults for channels/users can also live in `config.yaml`.

## Architecture

One long-lived Node process, no inbound server. The Slack adapter opens an **outbound websocket** (Socket Mode), so there is no public URL, webhook endpoint, or signature verification to host. State lives in the channel's own thread history and on disk — a restart loses nothing except in-flight runs.

```mermaid
flowchart LR
    subgraph channels ["Channel adapters — pure transport"]
        SL["Slack adapter<br/>Bolt, Socket Mode websocket<br/>src/channels/slack.ts"]
        CLI["CLI adapter<br/>src/cli.ts"]
        FUT["Discord / Teams / HTTP<br/>one adapter file each"]
    end

    subgraph core ["Core — channel-agnostic"]
        D{core dispatcher<br/>src/core/dispatcher.ts}
        CC["Config commands<br/>show / set / clear / help"]
        R["Resolution + permission gates<br/>request > user > channel > defaults"]
        RUN["runner.ts<br/>agent loop, up to maxTurns"]
    end

    subgraph providers ["Provider adapters"]
        A["anthropic<br/>@anthropic-ai/sdk"]
        O["openai-compatible<br/>fetch → any /chat/completions"]
    end

    subgraph exec ["Executors"]
        LX["local<br/>workspace dir on host"]
        EX["e2b<br/>per-thread micro-VM"]
    end

    SL & CLI -->|IncomingMessage + ChannelIO| D
    D --> CC
    D --> R --> RUN
    RUN <-->|provider/model prefix| A & O
    RUN <-->|bash / read / write| LX & EX
    D -->|status + replies via ChannelIO| SL & CLI
```

Channel adapters translate exactly three things: an incoming event → `IncomingMessage` (namespaced IDs: `slack:C0123`, `slack:U0123`, thread key `slack:C0123:<ts>`), history fetch → `HistoryItem[]`, and replies/status back to the platform (chunking, formatting, message editing are adapter concerns). Everything else is the dispatcher's.

**Agent loop** (`runner.ts`, vendor-blind): call `provider.complete()` → execute any requested tool calls → append results → repeat until the model stops or the turn budget runs out (coding 60, review 40, general 1). Progress notes edit a single Slack status message, rate-limited to one edit per 3s.

**Config resolution** — highest layer that specifies a value wins, independently for agent and model:

```mermaid
flowchart TD
    RQ["1 · Request directives<br/><code>agent:review model:openai/gpt-5</code>"]
    US["2 · User scope<br/><code>config set me …</code> + config.yaml users"]
    CH["3 · Channel scope<br/><code>config set channel …</code> + config.yaml channels"]
    DF["4 · Defaults<br/>config.yaml defaults.agent / defaults.models"]
    RQ -->|unset?| US -->|unset?| CH -->|unset?| DF
```

**Trust model (important):** the `review` agent is read-only by *toolset* (no `write_file`) and prompt convention — but `bash` can still mutate anything its executor can reach. The capability boundary depends on `execution.type`:

- `local` — tools run on the bot host; the boundary is the container filesystem/user and the scoped `GH_TOKEN`. Fine for dev and trusted operators.
- `e2b` — **control plane / execution plane split.** The bot (always-on, holds only Slack + model keys) ships every tool call to a per-thread E2B micro-VM that holds the repo checkout and `GH_TOKEN`. Blast radius of a malicious or prompt-injected request = its own sandbox plus a repo-scoped token; the bot host, other threads, and the hosting account are unreachable. Sandboxes expire after `timeoutMinutes` idle; thread follow-ups reconnect (map persisted in `data/sandboxes.json`), and an expired sandbox is transparently recreated (repos re-clone).

```mermaid
flowchart LR
    subgraph cp ["Control plane — always-on"]
        BOT["Switchboard bot<br/>Slack + model keys only<br/>no GH_TOKEN, no tool exec"]
    end
    subgraph ep ["Execution plane — ephemeral"]
        S1["Sandbox: thread A<br/>repo checkout + GH_TOKEN"]
        S2["Sandbox: thread B"]
    end
    BOT -->|exec / read / write per tool call| S1 & S2
    S1 & S2 -->|git push, gh pr create| GH["GitHub"]
```

The `Executor` interface in `src/execution/` is the seam — a Cloudflare Sandbox (or any other) backend is one file plus config, without touching agents, tools, or the runner.

## Deployment

The process must run somewhere always-on for the bot to be live. Because Socket Mode is outbound-only, "somewhere" is any box that can run a container — no ingress, load balancer, or TLS needed.

```mermaid
flowchart LR
    subgraph img ["One Docker image"]
        P["node dist/index.js<br/>+ git + gh<br/>health probe on :8080"]
    end
    img -->|A · wrangler deploy — recommended, house pattern| CF["Cloudflare Containers<br/>deploy/cloudflare/, terrateam-style"]
    img -->|B · fly deploy| FLY["Fly.io Machine<br/>fly.toml + volume at /app/data"]
    img -->|C · docker compose up -d| VPS["Any VPS / home server"]
    P -.->|outbound websocket| SLK["Slack"]
    P -.->|HTTPS| PRV["Model providers"]
    P -.->|git/gh over HTTPS| GH["GitHub"]
```

| Option | Fit | Notes |
|---|---|---|
| **A. Cloudflare Containers** (`deploy/cloudflare/`) — **recommended: the house pattern** | Proven in this org — `coreplanelabs/infrastructure` runs Terrateam (a long-lived server) exactly this way: singleton DO, `sleepAfter: 2h`, 5-min cron keep-alive. Our shim mirrors it, same account | Disk is ephemeral — but with `execution.type: e2b` workspaces live in sandboxes anyway, so the only loss on instance restart is `data/overrides.json` (put durable channel/user config in `config.yaml`). Thread context always rebuilds from Slack |
| **B. Fly.io Machine** (`fly.toml`) | Cheapest managed always-on (~$3–6/mo + volume) if org constraints don't apply | One volume at `/app/data` persists overrides + workspaces (set `workspaceDir: ./data/workspaces`) |
| **C. Docker on any VPS** (`docker-compose.yml`) | Max control / dev box | Volumes persist `data/` and `workspaces/`; compose restart policy covers supervision |

**Pairing note:** Cloudflare Containers + `execution.type: e2b` is the natural combination — the bot host becomes stateless-except-overrides, which is exactly what an ephemeral-disk platform wants. If you deploy on Cloudflare with `execution.type: local` instead, expect workspace checkouts to reset on instance restarts.

Railway/Render/k8s also work with the same image — anything that runs an always-on container with a volume. **Cloud sandbox providers (E2B, Modal, Daytona, Cloudflare Sandbox) are not a hosting option for the bot** — they solve a different problem: isolating each agent run's `bash` in a throwaway VM. That's the right future hardening step for the tool layer once untrusted users can reach the coding agent; the bot process itself still needs a long-lived home.

### Deploying on Cloudflare Containers (recommended)

Two Workers, deployed the same way `terrateam/` is in `coreplanelabs/infrastructure` (per-worker `package.json` with pinned wrangler, `secrets.txt`, manual `wrangler deploy` with Docker running):

```bash
# one-time: wrangler login (account: coreplane-infra), Docker running

# 0. Generate the shared bearer once: openssl rand -hex 32  (paste it as
#    SANDBOX_TOKEN into BOTH workers' secrets prompts below)

# 1. Sandbox worker — per-thread execution VMs at switchboard-sandbox.coreplanelabs.dev
cd deploy/cloudflare-sandbox && npm install
npm run secrets
npm run deploy

# 2. Bot worker — always-on Switchboard container
cd ../cloudflare && npm install
npm run secrets   # prompts through secrets.txt (Slack, Anthropic, SANDBOX_TOKEN, GitHub App)
npm run deploy
npm run tail      # watch it connect: "switchboard running (providers: anthropic...)"
```

The bot shim mirrors terrateam exactly: singleton Durable Object, `sleepAfter: 2h`, 5-minute cron keep-alive, secrets forwarded as container env, `startAndWaitForPorts` with generous timeout. Production behavior comes from `config/config.production.yaml` (committed, no secrets), selected via `SWITCHBOARD_CONFIG`; the sandbox Worker gets a stable custom domain on the `coreplanelabs.dev` zone so that config never changes.

### What any host must provide

Platform-agnostic requirements, for evaluating alternatives:

- **Runtime:** 1 always-on Docker container, single instance, no autoscaling; 0.25–0.5 vCPU, 512MB–1GB RAM (mostly idle)
- **Network:** outbound HTTPS only — Slack (`slack.com`/`wss-*.slack.com`), model provider APIs, `github.com`, E2B. **Zero inbound** — the app dials out over a websocket
- **Secrets as env vars:** `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `ANTHROPIC_API_KEY`, `E2B_API_KEY`, optionally `OPENAI_API_KEY`; `GH_TOKEN` only when `execution.type: local`
- **No cloud credentials on the host** — the app makes no cloud API calls, and its agents execute model-generated commands, so least privilege matters here specifically
- **Storage:** optional small persistent volume at `/app/data`; degrades gracefully without it (repos re-clone, thread context rebuilds from the channel)
- **Health/logs:** `GET :8080/healthz` → 200; logs on stdout

### Deploying on Fly.io

```bash
fly launch --no-deploy && fly volumes create switchboard_data --size 3
fly secrets set SLACK_BOT_TOKEN=... SLACK_APP_TOKEN=... ANTHROPIC_API_KEY=... E2B_API_KEY=...
fly deploy && fly logs   # set workspaceDir: ./data/workspaces in config.yaml first
```

### Deployment FAQ

**Can the bot itself run in a Cloudflare Sandbox?** Technically yes — a Cloudflare Sandbox is a container underneath, and terrateam proves long-lived processes run fine on Cloudflare Containers. But hosting the bot *via the Sandbox SDK* just re-implements deployment option A with an extra orchestration layer, so there's no reason to: deploy on Containers directly. Sandboxes earn their keep as the **execution plane** — where the agents' tools run (`execution.type: e2b` today; a Cloudflare Sandbox executor backend is one file plus a small proxy Worker, since its SDK runs Worker-side).

**Can it run on the Workers runtime / serverless-native?** Not as-is: the Slack adapter is a Socket Mode daemon and config/state use the filesystem. A serverless-native version means switching the Slack adapter to HTTP Events API (ack within 3s, continue work durably) and moving config/state off disk — the problem durable-agent frameworks (Vercel's eve, Cloudflare's Agents SDK) productize. Our seams map 1:1 onto those frameworks, so that door stays open; there's no reason to pay for it before horizontal scale matters.

## Usage in Slack

```
@switchboard help
@switchboard what's the syntax for a postgres lateral join?
@switchboard agent:coding ship a PR to github.com/acme/api that adds retry to the webhook sender
@switchboard agent:review model:anthropic/claude-opus-5 review acme/api#123
@switchboard config show
@switchboard config set channel agent=review
@switchboard config set me models.coding=openai/gpt-5
```

DMs to the bot work the same way (no mention needed).

## Permissions

Optional `permissions` block in `config.yaml` — absent means everything is open:

```yaml
permissions:
  admins: [slack:U0123ADMIN]      # bypass all restrictions
  agents:
    coding: [slack:U0456DEV]      # only these users (+ admins) may run coding
  channelConfig: []          # who may run `config set/clear channel`
                             # empty = admins only; key absent = everyone
```

- Agent allowlists are enforced **at run time against the resolved agent**, so they can't be bypassed via `agent:` directives, `config set me`, or channel defaults.
- `config set me` is always allowed — pointing yourself at a restricted agent is harmless because the run-time gate still applies.
- Denials reply in-thread naming the admins to ask; `config show` lists which agents are unavailable to you.

## Setup

1. **Create the Slack app** (api.slack.com/apps → From scratch):
   - Enable **Socket Mode**; create an app-level token with `connections:write` → `SLACK_APP_TOKEN`.
   - **OAuth scopes** (Bot Token): `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `im:history`, `im:read`, `im:write`.
   - **Event subscriptions**: `app_mention`, `message.im`.
   - Install to workspace → `SLACK_BOT_TOKEN`.
2. **Configure**:
   ```bash
   cp config/config.example.yaml config/config.yaml
   cp .env.example .env   # fill in tokens/keys
   ```
3. **GitHub identity for coding/review agents**: create a **GitHub App** on the org (Settings → Developer settings → GitHub Apps → New): permissions Contents + Pull requests, webhook off; generate a private key; install it on the repos the bot may touch. Set `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` — the bot mints 1-hour installation tokens on demand and injects them into sandboxes; PRs are authored as `<app-name>[bot]`. (Fallback: a repo-scoped fine-grained `GH_TOKEN` PAT.) With sandboxed execution the bot host itself needs no git/gh.
4. **Run**:
   ```bash
   npm install
   npm run dev          # or: npm run build && npm start
   ```

## Adding a provider

Add a block to `config.yaml` — no code needed for OpenAI-compatible endpoints:

```yaml
providers:
  groq:
    type: openai-compatible
    baseUrl: https://api.groq.com/openai/v1
    apiKeyEnv: GROQ_API_KEY
```

Then reference models as `groq/<model-id>` anywhere a model is accepted. For a provider with a genuinely different API, implement the small `Provider` interface in `src/providers/` and register it in `src/providers/registry.ts`.

## Adding an agent

Add an entry to `AGENTS` in `src/agents/registry.ts` (system prompt, toolset, turn/token budget) and give it a default model in `config.yaml` under `defaults.models`.

## Security notes

- The `bash` tool executes model-generated commands on the host with the bot's permissions. Run Switchboard in a container or dedicated user/VM, scope the `gh` token to the repos it should touch, restrict which channels can reach it, and put the `coding` agent behind a `permissions.agents` allowlist.
- API keys are only ever read from environment variables (`apiKeyEnv`), never from config files.
- Workspaces are confined for file tools, but `bash` is inherently unconfined — isolation belongs at the host level.
