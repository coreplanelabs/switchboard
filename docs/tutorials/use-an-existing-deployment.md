---
description: Send your first request through a Switchboard your team runs, then connect a local CLI or MCP client.
---

# Use an existing deployment

By the end, you have sent a request to your team's Switchboard and followed up in the same conversation. Someone else already runs the service and manages its model keys, tools, and access rules.

This walkthrough uses Slack and calls the app `@switchboard`. If your team renamed it, use the handle they gave you. Other installations may expose [browser chat](../reference/dashboard-routes.md) or another channel.

**You need:** the Slack workspace and app name your team uses, plus a channel where the app is present or a direct message with it. Ask the person who runs your deployment for these if you do not have them. You do not need to start a server.

## Send a request

In a channel with the app, mention it:

```text
@switchboard what can you help me with?
```

In a direct message with the app, send the question without a mention. You should see a 👀 reaction, a status card, and then an answer. The card names the agent chosen for your request.

## Follow up

Reply in the same thread without another mention:

```text
Can you give me a concrete example?
```

The reply stays in that conversation. For a longer task, describe the outcome you want in plain words. For example, if your deployment has access to the repository and you have permission to use its review agent:

```text
@switchboard review https://github.com/<org>/<repo>/pull/<number>
```

The status card links to the run page, where you can watch the work. Your deployment may require a separate dashboard sign-in. [Your first request in Slack](first-request-in-slack.md) walks through more kinds of requests and follow-ups.

## Connect an MCP client with SSO

If your deployment protects MCP with the same SSO as the browser, add `https://switchboard.example.com/mcp` as a remote HTTP MCP server in your client. Connect and complete the browser sign-in. You use the same account, grants and Slack identity link as browser chat. You do not need an ingress token or device approval.

For Cloudflare Access, the operator adds `/mcp` to the existing browser Access application and enables [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) there. Keep the same policies and application AUD. Allow only the callback URIs your MCP clients need; local clients may need localhost or loopback callbacks. Access handles OAuth discovery, registration and token refresh; Switchboard re-verifies the signed assertion with its existing dashboard verifier. Test the client sign-in after the bot change is deployed. Keep machine ingress routes outside the browser rule; if operator bearer clients still need `/mcp`, configure an explicit Access machine policy for them.

The MCP adapter uses the existing `DashboardVerifier` interface, not a Cloudflare-specific login flow. Other installations can supply another verifier behind that interface; the existing `token` strategy supports a proxy or fixed credential. `none` never enables unauthenticated MCP.

## Connect a local CLI and MCP client

Use this device approval flow for the local CLI or an MCP client without SSO support.

You need Node.js 24, your deployment's host, and dashboard sign-in. You do not need to run a local bot or supply model keys. Replace `switchboard.example.com` with your host:

```bash
npx -y @coreplane/switchboard connect switchboard.example.com
```

The command assumes HTTPS. Sign in, match the code in your browser to the one in your terminal, and click **Approve this device**. It checks your access, saves your credential privately in `~/.switchboard/client.json`, and configures Codex MCP. Restart Codex to load it.

When your dashboard email matches your Slack profile email, requests use your Slack identity. Repository actions may still require an administrator to link that identity to your GitHub login.

The CLI now uses your team's deployment:

```bash
npx -y @coreplane/switchboard ask "what can you do?"
```

To revoke access, open **Settings → Connect a local CLI or MCP client** and click **Revoke**. [CLI reference](../reference/cli.md) covers other commands and MCP clients.

**For the deployment operator:** enable one `mcp:personal:*` grant with `dispatch`, `runs:read`, and the actions your team needs. The approval page refuses connections until this grant is present.

## If you cannot get started

- No receipt in a channel: check that the app is in that channel. Ask your deployment operator which app and channel to use.
- A refusal: read the missing permission named in the reply, then ask the operator who manages access.
- A run page you cannot open: ask the operator how to sign in to the dashboard. The answer still appears in Slack.
- The connection page says MCP access is not enabled: the operator needs the shared `mcp:personal:*` grant. A connection that times out can be retried with a fresh code.

If you are the person setting up Switchboard for a team, follow [Get started](get-started.md) to run your own deployment.
