# Watch a run

See what Switchboard is doing right now, stop a run that has gone wrong, and read back a run that finished — from the dashboard, without Slack or the CLI.

## Before you start

- The dashboard's identity gate admits you. Which credential it checks is the installation's `dashboard.auth` strategy: a Cloudflare Access session, a bearer token, or loopback only on a local run ([Dashboard routes](../reference/dashboard-routes.md)).
- To stop a run you need the `runs:write` grant. To read back finished runs, the installation needs a `runHistory` block ([Turn features on and off](turn-features-on-and-off.md)).

## 1. Find the run

Every run gets a page, whichever surface started it. The Slack status card links to it. Otherwise open `/runs`: every active run, newest first. Click a row.

## 2. Read the page

`/runs/<id>` shows the request, the steps as they happen — files read, commands run, tool calls with their results — and the answer once it lands. While the run is live the page streams; leave the tab open. The header counts from the moment the message was received. When the agent stops it reads `delivering… · <total>` while the reply is posted, then `delivered in 2s` or `reply failed`.

Under the request, **Timeline** is the run's shape: `4m 12s — 34s getting ready · 2m 16s thinking · 1m 10s in tools · 8s finishing up · 4s Switchboard overhead`, a bar of the same numbers, and the three steps that took the most of their own time. While the run works, the line ends with what is open right now (`· currently thinking 1m 26s`). `Copy debug JSON` has the raw span names for a bug report. The Slack card closes with the same shape as its first detail line, and adds how long the message waited when it waited a minute or more (`queued … behind the previous run`).

## 3. Stop a run

From the page's stop control, or from chat or the CLI:

```
@switchboard runs stop <id> --mode soft      # let it write up where it got to
@switchboard runs stop <id> --mode hard      # abort mid-tool-call
```

`soft` is almost always the right choice. A follow-up someone sends to a stopped run is not run; the thread is told so.

## 4. Look back at finished runs

With `runHistory` configured, finished runs stay readable for the retention window: `/runs?all=1` includes them in the index, and a finished run's page is the same page, served without a live token. Without `runHistory`, a run leaves the dashboard about a minute after it finishes; the Slack thread still has the answer. Why that is a switch and not a bug: [Runs: live, then remembered](../explanation/runs-live-and-history.md).

## 5. The other panels

- **Scheduled**, on `/runs`: every cron job the installation runs, when it last fired, and a link to that firing's run (with `schedules` configured).
- **Residents**: `/residents` and `/residents/<owner>/<name>`, the dashboard twin of `repo list` ([Onboard a repo](onboard-a-repo.md)).
- **Costs**: `/costs` ([Check spend](check-spend.md)).

The header lists only the sections this installation has.

## What you did

You found a run from its card or the index, read its timeline, stopped one, and read back a finished one. Every view here is a route with a stated auth in [Dashboard routes](../reference/dashboard-routes.md); why a live page is opened by a token and a finished one by the policy table is [the decision record](../decisions/0013-capability-tokens-for-live-run-pages.md).
