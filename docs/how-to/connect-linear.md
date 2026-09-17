# Connect Linear

The Linear integration is being built in stages. OAuth, durable webhook intake,
native conversations, edge acknowledgements, dispatcher consumption, outbound
files, issue tools and lifecycle cancellation are wired. Inbound files and live
deployment verification remain in progress. Do not install the app for end users until the completed channel
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
| `LINEAR_BRIDGE_TOKEN` | Random internal bearer shared by the bot container and its edge bridge |

`PUBLIC_BASE_URL` already comes from the deployment profile. OAuth derives
the callback from that trusted origin, so a caller cannot select a different
callback through query parameters or a forged Host header. Credentials live
in the Worker's durable storage and never appear in callback responses.
Only the bridge bearer reaches the bot container; it permits fixed delivery
and session operations, with current app ownership checked on every request.
The bridge is disabled without that bearer.

The bot starts its consumer when `LINEAR_BRIDGE_TOKEN` is configured. Slack
credentials are optional for a Linear-only process; if either Slack token is
present, both are required and the Slack channel starts too. It requires
the durable run-history Worker and run ledger, so a container replacement can
rebuild the conversation and reconcile admitted work. It stops intake during
drain; pending deliveries survive in the edge inbox. The edge acknowledges new sessions
with a native thought before releasing them to the consumer. An alarm retries
failed acknowledgements under the same activity id, so container startup does
not delay the first response. If a request entered the
dispatcher but its durable admission cannot be proven, Switchboard reports the
interruption instead of repeating a possibly completed command.

Linear people have actor ids `linear:<workspace-id>:<user-id>` and use the
same open-chat baseline as Slack. Grant restricted agents and repositories
through those ids or `linear:*`; do not copy a Slack administrator's privileges
based on a matching display name. Linear team channel ids are
`linear:<workspace-id>:<team-id>`, and session thread ids are
`linear:<workspace-id>:<session-id>`.

The `work_item_get` and `work_items_delegated` tools read issues visible to the
requesting person. The queue uses Linear's delegate field, preserving the
human assignee. Issue edits, subissues and comments require `work-items:write`;
grant it to selected people or `linear:*` through the normal `grants` block.
Every operation refreshes the person's team membership and public-team access.
Even an administrator's Switchboard grant does not bypass Linear's private-team
boundary. Subissue creation does not automatically delegate another run.

Before a command, queued prompt or restored run starts, Switchboard checks the
requester's current access to the session's issue team. Removed membership or an
inactive account prevents execution. Temporary lookup failures keep queued and
restored work available for retry. Sessions outside issues are not yet supported:
their document or project visibility must be verified before their context can run.

When a session already has an active run, its original requester can steer it.
Another person’s prompt waits in the durable queue and starts a new turn under
that person’s grants after the active run finishes. Stop bypasses waiting prompts.
If a run fails with an unread follow-up and its next turn cannot check access,
Switchboard reports that the follow-up has not started and asks you to resend it.

An agent that needs missing information can call `request_input`. Switchboard
posts the question as a native elicitation, leaving the Linear session waiting
for input. Reply in that session to continue. The completed turn records that
it is awaiting input and preserves unfinished checklist items; it does not
publish an automatic PR or review verdict. Questions survive a bot restart.

Native Stop lets a person cancel their own active work through the shared
`runs:stop` policy. Stopping another person's work requires `runs:write` and
visibility of that run. A Linear session does not establish team-wide membership;
configure an operator's channel grants explicitly. Revocation and access removal are
infrastructure cancellations and require no new grant from the former requester.

Coding runs can return files through `attach_file`. With an artifact store,
the executor streams the file to a private Linear upload using a short-lived
signed ticket; the bot never holds its bytes or gives the executor a Linear
token. Without an artifact store, the existing bounded byte-upload path is
available. Images render inline in native progress and other files appear as
links; the run's final answer still determines completion. Inbound private file
retrieval remains in progress.

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
