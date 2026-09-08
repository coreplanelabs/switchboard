# Check spend

Read what the installation costs, per day and per group, on the dashboard or from a script.

**You need:**

- A `costs` block in `config.yaml`: the Cloudflare account and the groups of Workers, containers and Durable Objects to price.
- `CF_ANALYTICS_TOKEN` (Account Analytics: Read); optionally `ANTHROPIC_ADMIN_KEY` for model spend.
- A dashboard session.

Without the block, **Costs** is not in the header and `/costs` answers 503.

## Open the dashboard

Open `/costs`: daily spend for every configured group. Each load prices live from Cloudflare's billing data and, with the admin key, Anthropic's; nothing is estimated or cached.

## Narrow to one group

Open `/costs/<group>`.

## Script it

Fetch `/costs/<group>.json`: the same data, machine-readable, behind the same gate. Send what the installation's `dashboard.auth` strategy expects:

| `dashboard.auth` | Send |
|---|---|
| `access` | a service token |
| `token` | the bearer |

## Next

- [Turn features on and off](turn-features-on-and-off.md): the `costs` block and its tokens.
- [Dashboard routes](../reference/dashboard-routes.md): the three `/costs` routes and their auth.
