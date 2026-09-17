# Connect Linear

The Linear integration is being built in stages. OAuth installation and
durable webhook intake exist; dispatch and native session replies are not yet
wired. Do not install the app for end users until the channel delivery stage
is deployed. See the [delivery plan](../plans/2026-09-17-001-linear-channel.md).

## Register the application

In Linear's API settings, create a private OAuth application named after your
Switchboard installation. Set its GitHub username to the bot account that
authors its pull requests. Register these redirect URIs, using the bot's
public hostname for the first:

```text
https://<bot-hostname>/oauth/linear/callback
http://localhost:8080/oauth/linear/callback
```

Enable webhooks at `https://<bot-hostname>/webhooks/linear`. Subscribe to Agent
session events, Inbox notifications, Permission changes and OAuth
authorization events. Public distribution and client-credentials grants are
not required. The application UUID in the settings URL is different from its
OAuth Client ID; keep both.

## Configure the Worker

Store these values through the deployment's secret source and the existing
`deploy secrets bot` command:

| Variable | Value |
|---|---|
| `LINEAR_CLIENT_ID` | OAuth Client ID from the application settings |
| `LINEAR_CLIENT_SECRET` | OAuth client secret |
| `LINEAR_APPLICATION_ID` | Application UUID from the settings URL |
| `LINEAR_WEBHOOK_SECRET` | Webhook signing secret |
| `LINEAR_ORGANIZATION_ID` | Optional workspace UUID to restrict installation and intake to one workspace |

`PUBLIC_BASE_URL` already comes from the deployment profile. OAuth derives
the callback from that trusted origin, so a caller cannot select a different
callback through query parameters or a forged Host header. Credentials live
in the Worker's durable storage and never appear in callback responses.

The edge's `LINEAR_STATE` binding is independent of the bot container. Deploy
the Worker migration before using the OAuth endpoints. Once the full channel
is deployed, a workspace admin opens `<PUBLIC_BASE_URL>/oauth/linear/authorize`
to install. The grant requests app identity, read/write access, mentions and
delegation. Local OAuth must start on the local host too, so the browser-bound
cookie returns to the same origin; merely registering a localhost callback
does not forward production webhooks to a laptop.

## Test the edge locally

From a checkout, put the Linear variables in the gitignored
`deploy/cloudflare/.dev.vars` file, then run:

```bash
npm run dev -w deploy/cloudflare -- --config linear.local.jsonc --local --port 8080
```

This runs only OAuth and webhook intake in the local Workers runtime, with
durable local storage. It needs neither a Docker build nor a Cloudflare
account. Open `http://localhost:8080/oauth/linear/authorize` to test the local
callback. Live webhook testing also requires a reachable development endpoint;
the production app's webhook URL still points at production.
