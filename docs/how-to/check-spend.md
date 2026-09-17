# Check spend

Read what the installation costs, per day and per group, on the dashboard or from a script.

**You need:**

- A `costs` block in `config.yaml`: the Cloudflare account and the groups of Workers, containers and Durable Objects to price.
- `CF_ANALYTICS_TOKEN` (Account Analytics: Read); optionally `ANTHROPIC_ADMIN_KEY` for model spend.
- A dashboard session.

Without the block, **Costs** is not in the header and `/costs` answers 503.

## Open the dashboard

Open `/costs`: daily spend for every configured group, newest day first, with `today · 7d · 30d` ranges (UTC days; the cost sources have nothing finer, and Cloudflare holds no analytics older than 32 days). Every figure comes from a snapshot of Cloudflare's billing data and, with the admin key, Anthropic's — read once a day (`costs.snapshot.everyHours`, default 24) by the bot itself, never in a page load, so the page opens at once. The line under the range says which snapshot you are looking at, how old it is and when the next one is due; `today` on the page is the day the snapshot was taken. One figure is an estimate and says so: the day Anthropic's cost report has not closed yet (today, and yesterday until a few hours after midnight UTC) is the hourly usage report priced at list.

Right after a fresh installation starts there is no snapshot yet: the page says so and the first one lands within a minute.

## Take a snapshot now

Click **Snapshot now** beside the status line (it is there when your session holds `costs:write`), ask the bot for `costs snapshot` in Slack, or run `switchboard costs snapshot` on the CLI. Every open costs page shows the take as it happens — the line reads `Taking a snapshot now…` and the figures repaint when it lands, no reload needed. The take reads both billing sources and the run history once (a few seconds, half a minute in a bad one), stores the result, and the page shows it on the next load with your name on the status line. The command needs the `costs:write` grant — an admin's `all` or a `grants` entry that names it — because a take reads two providers and replaces what every viewer sees.

## When a take fails

The previous snapshot keeps serving and the status line names the failure (`last attempt 5 minutes ago failed (3 in a row): …`) until a take lands. The bot retries by itself, waiting longer after each failure in a row — a minute, two, four, up to an hour — so a provider outage is not hammered; the line says when the next attempt is due. Set `costs.snapshot.alertChannel` (`slack:C…`) to have the bot post one line to a channel after three failed takes in a row, and one more when a take lands again. `costs snapshot` is never held back by the retry wait.

## Narrow to one group

Open `/costs/<group>`.

## See who, what and which model spent it

The tabs above the tables lay the same dollars against the runs: **By user**, **By thread**, **By channel**, **By agent** and **By model** (`/costs/<group>?view=users|threads|channels|agents|models`). Each row is one key with its runs, the LLM dollars from the runs' tokens priced through the price table (`costs.prices` over the Anthropic list), the day's Cloudflare spend allocated by the key's share of run wall-clock (an allocation, not a meter — and none on the model tab, where a run may span models and the rows carry LLM alone), the total and its share. A child run bills to whoever started its parent, in the child's own thread and agent. A model neither table knows reads `unpriced tokens`, never $0. The coverage line says where the run history begins and how many runs are still being priced; the reconciliation line ties the attributed LLM to the group's own figure. On the By user tab, **me** keeps your own rows when your sign-in email matches a Slack user.

The same report on every command surface: `costs by user` in Slack (the `costs:read` grant; a browser session holds it), `switchboard costs by agent --days 7 --group <group>` on the CLI, `GET /api/costs.by?dimension=model` over HTTP, the `costs_by` MCP tool. The JSON twins are `/costs/<group>/<view>.json`.

Every finished run's own dollars are on its run page beside the duration and in `runs get` as `cost` — the same tokens priced the same way, `unpriced` for a model without a price. A model the list does not know (another provider's, a new release) is priced by naming its rates under `costs.prices` in `config.yaml`.

## Script it

Fetch `/costs/<group>.json`: the same data, machine-readable, behind the same gate. Send what the installation's `dashboard.auth` strategy expects:

| `dashboard.auth` | Send |
|---|---|
| `access` | a service token |
| `token` | the bearer |

## Next

- [Turn features on and off](turn-features-on-and-off.md): the `costs` block and its tokens.
- [Dashboard routes](../reference/dashboard-routes.md): the three `/costs` routes and their auth.
