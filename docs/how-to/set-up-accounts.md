# Set up accounts

Goal: every external account OpenSwitchboard can use, created with exactly the permissions the code needs — and a clear line between the two you must have and the ones that buy you a feature.

| Account | Required? | What it unlocks | Where the credential goes |
|---|---|---|---|
| A Slack app | yes, for Slack | The Slack channel: mentions, threads, status cards | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` |
| One model provider | yes | Every agent | `ANTHROPIC_API_KEY`, or the variable your provider block names |
| A GitHub App | for coding and review | Reading repositories and issues; the coding agent's branches and pull requests | `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` |
| Cloudflare | for production | Hosting; the state Worker, residents, sandboxes, dashboards behind Access | wrangler's login, plus a deploy token for CI |
| E2B | optional | Per-thread sandboxes without a Cloudflare account | `E2B_API_KEY` |
| Brave Search | optional | The research agent's web search | `BRAVE_SEARCH_API_KEY` |

Credentials are read from environment variables only, never from `config.yaml`; `config.yaml` names the variable (`apiKeyEnv`, `tokenEnv`) and the environment carries the value. Locally that is `.env`, which the bot and the CLI load at startup from the directory they run in (a variable your shell exports wins over the file); on Cloudflare it is a Worker secret ([Deploy](deploy.md)).

## The Slack app

The fastest path is the checked-in manifest — [`slack-app-manifest.yaml`](https://openswitchboard.dev/slack-app-manifest.yaml), `docs/public/slack-app-manifest.yaml` in the tree. At [api.slack.com/apps](https://api.slack.com/apps) choose *Create New App* → *From a manifest*, pick the workspace, paste the file, create. Then two manual steps a manifest cannot do:

1. **App-level token** — *Basic Information* → *App-Level Tokens* → generate one with the scope `connections:write`. It starts with `xapp-` and is `SLACK_APP_TOKEN`: the credential for the Socket Mode websocket.
2. **Install** — *Install App* → *Install to Workspace*. The *Bot User OAuth Token* starts with `xoxb-` and is `SLACK_BOT_TOKEN`.

If you build the app by hand instead, this is what the manifest asks for and why. Every scope is one the adapter's Web API calls need; the bot checks the token's granted scopes on its first connection and logs any that are missing, because a missing scope is otherwise a silent failure.

| Bot scope | Why |
|---|---|
| `app_mentions:read` | Receive the `app_mention` event — how a conversation starts in a channel. |
| `chat:write` | Post the reply and edit the status card in place (`chat.postMessage`, `chat.update`). |
| `channels:history`, `groups:history` | Read a thread's messages, so a reply in a thread the bot is part of reaches it without a re-mention, and so the reconnect catch-up can re-read recent history after a disconnect. Public and private channels respectively. |
| `channels:read`, `groups:read` | List channels and their members: the catch-up scans the channels the bot is in, and a run's label names the channel. Without these the catch-up cannot start. |
| `users:read` | Resolve a user's display name for run labels. |
| `files:read` | Download attachments — an image on a message is passed to the model; without the scope it is reported as unavailable. |
| `files:write` | Attach long command output as a file instead of a run of chunked messages; without it the adapter falls back to chunks. |
| `reactions:write` | The 👀 receipt the moment a request is accepted; without it requests still run, without the receipt. |
| `im:history`, `im:read` | Direct messages to the bot. Leave them out for a channel-only bot. |

Optional: `users:read.email`. It is read once when a person connects an MCP server, to bind the one-time connect link to them ([Connect an MCP server](connect-an-mcp-server.md)); nothing on the message path uses it.

| Event | Why |
|---|---|
| `app_mention` | A mention anywhere the bot is present. |
| `message.channels`, `message.groups` | Thread follow-ups in public and private channels. The adapter ignores top-level channel posts and messages from other bots; only a reply in a thread the bot has posted in or been mentioned in is handled. |
| `message.im` | Direct messages. |

Socket Mode must be on. There is no request URL to configure: the bot connects outward, which is why it can run from a laptop with no public address.

## Model provider keys

One provider is required and the example config names two. Each `providers` entry says which environment variable holds its key:

```yaml
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
  openai:
    type: openai-compatible
    baseUrl: https://api.openai.com/v1
    apiKeyEnv: OPENAI_API_KEY
```

The `openai-compatible` type covers any endpoint that speaks that API — Groq, a local Ollama or vLLM server — with a different `baseUrl` and variable; no code is involved. A model is then named as `<provider>/<model>` wherever a model is accepted: the defaults in `config.yaml`, a `config set` command, or a `model:` directive on one message. A key that is missing surfaces on the first request to that provider, as the provider's own authentication error on the status card, so check the variable is set before you wonder about the model.

An optional second Anthropic credential, an Admin API key in `ANTHROPIC_ADMIN_KEY`, lets the costs dashboard show model spend beside infrastructure spend; without it the costs page shows the Cloudflare side only.

## The GitHub App

A GitHub App is the recommended identity for the coding and review agents: it is owned by the organization rather than a person, uses no seat, and the bot mints one-hour installation tokens from its private key on demand instead of holding a long-lived token. Pull requests are authored as `<app name>[bot]`.

1. **Create the App.** Organization *Settings* → *Developer settings* → *GitHub Apps* → *New GitHub App*. Name it; the homepage URL can be your docs or repository. Under *Webhook*, untick *Active* — the App receives no events.
2. **Repository permissions.** These are the permissions the bot's token requests and the tools call:

   | Permission | Level | Used for |
   |---|---|---|
   | Contents | Read and write | Cloning and reading files; the coding agent's branches and pushes. |
   | Pull requests | Read and write | Reading a PR and its diff; opening the coding agent's PR; the review agent's posted review. |
   | Issues | Read and write | Reading an issue for task context; creating, updating, closing and commenting; labels (the self-improvement proposals are labelled issues). |
   | Metadata | Read-only | Set automatically; every App needs it. |

   Leave *Where can this GitHub App be installed?* at *Only on this account*.
3. **Generate a private key.** *Private keys* → *Generate a private key*; a `.pem` file downloads. Its contents are `GITHUB_APP_PRIVATE_KEY`. In a `.env` file the key may be one line with literal `\n` sequences between the PEM lines — the bot unescapes them.
4. **Note the App id.** It is on the App's *General* page, as `GITHUB_APP_ID`.
5. **Install it.** *Install App* → your organization → *Only select repositories*, and pick the repositories the agents may touch. The installation id is the last path segment of the page you land on, `…/settings/installations/<id>`; that is `GITHUB_APP_INSTALLATION_ID`.

Three consequences of the installation being the boundary. A repository outside the installation is not reachable: the `github_repos` tool lists exactly the installation's repositories, and onboarding a resident for a repository outside it is refused, since a token scoped to that repository cannot be minted. A read-only agent's sandbox — the review agent's — receives a token minted with a read-only subset of these permissions (contents, pull requests, issues, actions and checks read; metadata), so it can read the code, the PRs and the CI results but physically cannot push, comment or re-run a workflow even if a prompt-injected diff tells it to. And the token is re-minted per command with margin to spare, so a command that starts on a token finishes on it.

**On the resident Worker too.** If you run resident repositories, set the same three secrets on the resident Worker: it holds its own copy of the key and mints its own repository-scoped tokens, deliberately separate from the bot's ([Security model](../explanation/security-model.md)). Rotate the key by generating a new one, putting it on both Workers, then revoking the old one.

**Fallback: a personal token.** `GH_TOKEN` holding a fine-grained personal access token scoped to the same repositories works in place of the App triple, with the same permissions. It is a person's identity and a long-lived secret; use it for a solo installation, not a team.

## Cloudflare (optional, and what it buys)

Nothing about OpenSwitchboard requires Cloudflare. A laptop or any always-on container runs the bot; `docker-compose.yml` is that shape. Cloudflare is the one supported production target, and each of its pieces turns on a capability the bot cannot have alone ([Turn features on and off](turn-features-on-and-off.md) is the matrix):

| Piece | What it buys |
|---|---|
| **The bot as a container** | An always-on process with no host to maintain; deploys that wait for the new container to be live before reporting success. |
| **The state Worker** | Everything that must survive a bot restart: the config document the bot reads at startup, chat-set overrides, run history and the run ledger (a live run survives a restart), cross-session memory, schedule firings. One Worker, one bearer (`MEMORY_TOKEN`), four config blocks. |
| **The sandbox Worker** | Each thread's `bash` runs in its own throwaway container instead of on the bot host — the thing that makes it safe to let untrusted users reach the coding agent. |
| **The resident Worker** | Always-warm checkouts of the repositories you onboard, so a coding run starts on an installed tree instead of cloning cold; its own GitHub credential. The most expensive piece: one container per onboarded repository. |
| **Cloudflare Access** | Identity in front of the dashboards (`/runs`, `/residents`, `/costs`). Without an identity gate the dashboards refuse every remote caller; Access is how a team gets in with SSO, and service tokens are how machines call `/api/*`. |

What you need: an account, a domain in it (every hostname in the deployment profile must be under a zone in the account), `npx wrangler login` once, and Docker running wherever `deploy all` runs — the bot's image is built there. For deploys from CI, a Cloudflare API token with *Workers Scripts: Edit*, *Containers: Edit*, *Workers R2 Storage: Edit* and *Account Settings: Read* at the account, and *Workers Routes: Edit* and *DNS: Edit* on the zone; `deploy all` checks the token's capabilities before it touches a Worker, because a token that can deploy the state Worker but not list containers would strand the bot half-deployed. The Access application, if you want one, is created in the Zero Trust dashboard by hand: its team domain and AUD tag go in the profile's `access` block and reach the bot as `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. The whole sequence is [Deploy](deploy.md).

## E2B (optional)

E2B gives you per-thread sandboxes with an API key and nothing to deploy — the alternative to the sandbox Worker for an installation that is not on Cloudflare. Create a key at E2B, put it in `E2B_API_KEY`, and set the executor:

```yaml
execution:
  type: e2b
  apiKeyEnv: E2B_API_KEY
  timeoutMinutes: 30
```

Each thread gets its own micro-VM holding its checkout and a GitHub token scoped to what that agent may do; the VM expires after `timeoutMinutes` idle and is recreated on the next follow-up. The bot host holds no repository credential in this mode.

## Brave Search (optional)

The research agent searches the web through Brave. Create a key at Brave Search API and put it in `BRAVE_SEARCH_API_KEY`. Without it the research agent has no web search; the other agents are unaffected.

## See also

- [Deploy](deploy.md) — where each of these values goes in production, and how it is rotated.
- [Reference: configuration](../reference/configuration.md) — every block that names an environment variable.
- [Explanation: security model](../explanation/security-model.md) — why the GitHub credential lives where it does.
