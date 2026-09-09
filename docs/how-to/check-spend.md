# Check spend

Read what the installation is costing, per day and per group, from the dashboard or from a script.

## Before you start

- A `costs` block in `config.yaml` naming the Cloudflare account and the groups of Workers, containers and Durable Objects to price, plus `CF_ANALYTICS_TOKEN` (Account Analytics: Read). Optionally `ANTHROPIC_ADMIN_KEY` for model spend. Without the block, **Costs** is not in the header and `/costs` answers 503 ([Turn features on and off](turn-features-on-and-off.md)).
- The dashboard's identity gate admits you ([Dashboard routes](../reference/dashboard-routes.md)).

## 1. Open the dashboard

`/costs` shows daily spend for every configured group. Nothing is estimated or cached: each load prices live from Cloudflare's billing data and, when the admin key is set, from Anthropic's.

## 2. Narrow to one group

`/costs/<group>` is one group's page.

## 3. Script it

`/costs/<group>.json` is the same data, machine-readable, behind the same gate. Send the credential the installation's `dashboard.auth` strategy expects: a service token under Access, the bearer under `token`.

## What you did

You read the installation's spend by group and know the JSON twin to alert on. The figures cost two read-only API tokens; nothing is stored.
