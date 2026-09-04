# Reference: dashboard routes

Every route below sits behind Cloudflare Access (browser session or, for machine callers, a service token) unless noted. None of them set caching headers that would let a proxy or browser cache a response beyond the request that made it (`no-store` throughout) — every load is live.

| Route | Shows | Notes |
|---|---|---|
| `GET /runs` | Active runs, newest first | Default view excludes finished runs; each row's link carries that run's capability token — the index itself is Access-gated specifically because of this |
| `GET /runs?all=1` | Active **and** finished runs | Only meaningful with `runHistory` configured — otherwise there's nothing finished to show |
| `GET /runs/<id>` | One run: request → steps (tool calls, results) → answer | Live via SSE while the run is active; served as a static page, no token needed, once it's in history |
| `GET /runs/<id>/events` | Raw SSE event stream for that run | What the run page itself consumes; resumable via `Last-Event-ID` |
| `GET /runs/<id>/friction` | Why a finished run was slow, if it was | Read-only diagnosis, no side effects |
| `POST /runs/<id>/stop?mode=soft\|hard` | — | Stops a live run; `soft` lets it wrap up and answer, `hard` aborts in-flight |
| `GET /residents` | Every onboarded repo and its lifecycle state | The dashboard twin of `repo list` |
| `GET /residents/<owner>/<name>` | One repo's resident: mirror status, warm checkout, active thread worktrees | |
| `GET /costs` | Daily spend across every configured group | Priced live from Cloudflare + (optionally) Anthropic billing data, nothing cached |
| `GET /costs/<group>` | Spend for one group | |
| `GET /costs/<group>.json` | Same data, machine-readable | For scripting/alerting, not for embedding a live dashboard elsewhere |
| `GET /mcp/connect/<nonce>` | The one-time MCP credential-paste form | Bound to whoever mints it or first opens it; single use, expires in 10 minutes |
| `GET /healthz` | `{ok, inFlight, draining, catchUp}` | **Not** Access-gated — this is the process health probe, meant to be hit by the deploy tooling and the container platform |

## Screenshots

**Residents index** — every onboarded repo, its state, last activity:

<img src="../images/residents-index.jpg" alt="Residents index" width="720">

**Resident detail** — one repo's mirror, warm checkout, and per-thread worktrees:

<img src="../images/resident-detail.jpg" alt="Resident detail" width="720">

## What's not on the dashboard yet

There is no `/mcp` listing page — `mcp list` in chat/CLI/HTTP is the current data contract for "what's connected." The frontend (`web/`) is a Vue 3 app served entirely from a JSON seed embedded in the page (no client-side data fetching to a separate API for the initial render), which is why every route above renders instantly with no loading spinner for its first paint.
