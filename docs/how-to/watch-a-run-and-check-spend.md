# Watch a run, and check what it's costing

Goal: use the dashboard to see what's running right now, look back at what already ran, stop something that's gone sideways, and check spend — all without touching Slack or the CLI.

Everything below sits behind your org's Cloudflare Access — only signed-in teammates can load it.

## Watch something live

Every run Switchboard starts — from Slack, the CLI, or anywhere else — gets a page. The status card in Slack links to it directly; you can also browse to it:

- `/runs` — every currently active run, newest first. Click any row.
- `/runs/<id>` — that run's page: the request, a live-updating list of steps (files read, commands run, tool calls with their results), and the answer once it's done. While it's running, this streams over SSE — leave the tab open and watch it work. The header counts the whole run from the moment Switchboard received your message. When the agent stops it reads `delivering… · <total>` while the reply is posted, and then `delivered in 2s` — how long the reply took to land — or `reply failed`. On the index the row stays amber for that stretch, with `delivering the reply` on its dot.

## Stop one

From the run page, or directly:

```
npx tsx src/cli.ts runs stop <id> --mode soft   # let it wrap up and answer now
npx tsx src/cli.ts runs stop <id> --mode hard   # abort mid-tool-call
```

`soft` is almost always the right choice — it asks the agent to write up where it got to instead of cutting it off mid-thought.

## Look back at finished runs

If your deployment has `runHistory` configured (see [reference: configuration](../reference/configuration.md)), finished runs stay readable for a retention window instead of disappearing:

- `/runs?all=1` — include finished runs in the index, not just active ones.
- A finished run's page is the *same* page, served without a live token — no capability leaks once a run is done. It shows the same total and the same `delivered in` caption the live page ended on; a run with no caption had no reply measured (a command that fell through to the agent, a run cut down by a restart).

Without `runHistory` configured, runs are live-only: once finished, a run drops off the dashboard within a minute (though the Slack thread it replied in still has the answer). See [explanation: runs, live and after](../explanation/runs-live-and-history.md) for why this is a deliberate on/off switch, not a bug.

## Scheduled jobs

The same `/runs` page has a **Scheduled** panel — every cron job Switchboard runs (the weekly self-improvement pass, keep-alive pings), when it last fired, and a link to that firing's run.

## Residents

`/residents` and `/residents/<owner>/<name>` — the dashboard twin of `repo list`: which repos are warm, their lifecycle state, active threads. See [onboard a repo](onboard-a-repo.md).

## Spend

`/costs` — daily spend for each configured group (Cloudflare Workers/containers plus, where an admin key is set, Anthropic API spend), with a JSON twin at `/costs/<group>.json` for scripting. Priced live from Cloudflare's and Anthropic's own billing data — nothing is estimated or cached.

## See also

- [Reference: dashboard routes](../reference/dashboard-routes.md) — every route, its auth, its query params.
- [Explanation: runs, live and after](../explanation/runs-live-and-history.md).
