# Set up accounts

By the end, every external account Switchboard can use exists with exactly the permissions the code needs, and each credential is where the bot reads it.

**You need:** admin rights in the Slack workspace, the GitHub organization and, for production, the Cloudflare account.

| Account | Required? | What it unlocks | Credential |
|---|---|---|---|
| A Slack app | for Slack | Mentions, threads, status cards | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` |
| One model provider | yes | Every agent | `ANTHROPIC_API_KEY`, or the variable your provider block names |
| A GitHub App | for coding and review | Repository reads; pull requests | `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` |
| Cloudflare | for production | Hosting; the Workers; Access | `CLOUDFLARE_API_TOKEN` |
| E2B | optional | Per-thread sandboxes without Cloudflare | `E2B_API_KEY` |
| Brave Search | optional | The research agent's web search | `BRAVE_SEARCH_API_KEY` |

Credentials are environment variables: `.env` locally, a Worker secret on Cloudflare ([Deploy](deploy.md#stage-the-secrets)).

## Create the Slack app

1. At [api.slack.com/apps](https://api.slack.com/apps): *Create New App* → *From a manifest* → paste [`slack-app-manifest.yaml`](https://switchboard.space/slack-app-manifest.yaml).
2. *Basic Information* → *App-Level Tokens* → generate one with `connections:write`: `xapp-…` is `SLACK_APP_TOKEN`.
3. *Install App* → *Install to Workspace*: the *Bot User OAuth Token* `xoxb-…` is `SLACK_BOT_TOKEN`.

Socket Mode is on in the manifest. Its scopes cover mentions, replies, thread history, channel lists, user names, files, the 👀 reaction and direct messages. The bot logs any scope its token lacks on first connection.

## Add a model provider key

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

`openai-compatible` covers Groq, Ollama or vLLM with another `baseUrl`. An Admin API key in `ANTHROPIC_ADMIN_KEY` adds model spend to the costs page.

## Create the GitHub App

1. Organization *Settings* → *Developer settings* → *GitHub Apps* → *New GitHub App*. Under *Webhook*, untick *Active*.
2. Repository permissions:

   | Permission | Level | Used for |
   |---|---|---|
   | Contents | Read and write | Cloning; branches and pushes |
   | Pull requests | Read and write | Reading a PR; opening one; posting the review |
   | Issues | Read and write | Reading tasks; creating, commenting, labelling |
   | Metadata | Read-only | Set automatically |

3. *Private keys* → *Generate a private key*: the `.pem` is `GITHUB_APP_PRIVATE_KEY`.
4. The *General* page shows the App id: `GITHUB_APP_ID`.
5. *Install App* → your organization → *Only select repositories*. The installation id ends the URL you land on: `GITHUB_APP_INSTALLATION_ID`.

```bash
npx @coreplane/switchboard init --force --organization <org> --anthropic-key <key> --github-app-id <app id> --github-installation-id <installation id> --github-private-key-file <path to .pem>
```

- A repository outside the installation is refused by name; the review agent gets a read-only token.
- The resident Worker needs the same three secrets.
- Fallback for a solo installation: `GH_TOKEN`, a fine-grained personal token.

## Cloudflare

Cloudflare is the one production target. You need an account, a zone in it, and an API token for the account in `CLOUDFLARE_API_TOKEN` with *Workers Scripts: Edit*, *Containers: Edit*, *Workers R2 Storage: Edit* and *Account Settings: Read* on the account, plus *Workers Routes: Edit* and *DNS: Edit* on the zone. Containers Edit is also what the image copy into your registry needs.

An Access application's team domain and AUD go in the profile's `access` block.

## E2B

```yaml
execution:
  type: e2b
  apiKeyEnv: E2B_API_KEY
  timeoutMinutes: 30
```

## Brave Search

Set `BRAVE_SEARCH_API_KEY`; without it the research agent has no web search.

## Next

- [Configuration](../reference/configuration.md): every block that names an environment variable.
- [Security model](../explanation/security-model.md): why the GitHub credential lives where it does.
