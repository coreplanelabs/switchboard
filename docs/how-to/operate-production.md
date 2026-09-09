# Operate production

Change what runs in production — a deploy outside a release, a new config, a look at what the bot is doing — without breaking a run that is in flight.

Production is four Cloudflare Workers ([Worker topology](../explanation/worker-topology.md)), deployed from CI on every release ([Ship a release](ship-a-release.md)). This page is for the moments a person is involved. Bringing an installation up from nothing, and the deploy commands themselves, are [Deploy](deploy.md); the selection and ordering rules are the contract in [Release and deploy](../reference/specs/release-and-deploy.md).

## Before you start

- A checkout at `origin/main` with `npm ci` run, and the deployment profile in reach: `deploy/profile.json`, or `SWITCHBOARD_DEPLOY_PROFILE` naming where it lives — a path, `github://owner/repo/path@ref` read with `CONFIG_REPO_TOKEN`, or a secrets-manager reference.
- A Cloudflare login for the profile's account, and no `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` in the shell. `deploy all` strips the account id and refuses a token for another account with wrangler's own words, never silently replacing it with your login.
- For `deploy restart` and the span log, an ingress bearer whose subject holds `deploy:write` or `trace:read` in `grants`.

## 1. Read what is running

`GET /healthz` on the bot is public and reports `build.commit` (the commit the container serves), `inFlight`, `draining` with `drainDeadlineMs` and `drainStartedAt`, `startedAt`, and the reconnect catch-up's state. Every live gate below reads it; so should you before touching anything.

```bash
npm run cli -- deploy plan --affected
```

prints which Workers are stale against what they serve and why, the order, and the preflight each step runs. It executes nothing and needs no `config/config.yaml`, so it runs from any worktree.

## 2. Deploy outside a release

Prefer the workflow, which is the runner CI uses and refuses any ref but `main`:

```bash
gh workflow run deploy-production.yml --ref main -f targets=affected
gh workflow run deploy-production.yml --ref main -f targets=bot,resident
```

From a checkout, `npm run cli -- deploy all --affected` is the same command with the same checks. `deploy all` is the only runner: memory (the state Worker, whose Durable Object migrations must exist before the bot writes to them), then bot, then resident, then sandbox — never the four by hand in parallel. Each step has a preflight, and a refusal is waited out (a retry every 60 s, the resident's for up to 30 minutes), never forced unless `--force` is passed:

- **The bot's** refuses only while the container application is mid-rollout. A second rollout on top of one in progress replaces the instance the first put into its drain and kills whatever it was running. Runs in flight do not refuse it: on SIGTERM the bot hands every resumable run to the next container, which continues it under the same card within seconds. A `ship` pipeline is the exception; it holds the drain until it finishes, up to 15 minutes. The step is done only when `/healthz` reports the new commit and no drain.
- **The resident's** refuses while any resident has work in flight, because a Worker deploy swaps the Durable Object isolates under running threads. It needs a resident bearer in the environment (`RESIDENT_READ_TOKEN` is enough) and fails closed without one.

`SWITCHBOARD_DEPLOY_FORCE=1` and `RESIDENT_DEPLOY_FORCE=1` bypass a Worker's own `npm run deploy` preflight, and `-f force=true` bypasses them on the workflow. Say why in the run.

## 3. Change the config without a release

The image carries no config. The bot reads its config at startup from the state Worker's `base` document, which `deploy all` pushes before the bot step. To change it on its own:

```bash
npm run cli -- deploy config       # from the profile's configSource, or --source <path|github://…|op://…>
npm run cli -- deploy restart      # the running container keeps the config it started with
```

`deploy config` validates before it writes and refuses an unreadable source, a config that does not validate, or a missing `MEMORY_TOKEN`. Secrets follow the same two steps: [Rotate a secret](rotate-a-secret.md).

## 4. Keep the Worker configs generated

Each Worker's `wrangler.jsonc` is rendered from the `wrangler.template.jsonc` beside it and the profile by `npm run deploy:gen` (`deploy init`), and is gitignored. Change a binding, a cron or an instance size in the template and commit that; change an account or a hostname in the profile. `npm run deploy:check` says whether a rendered file was edited by hand.

## 5. Read the bot's span log

The container's stdout is not readable from outside, and the log sink prints only root spans there. The bot keeps every span end in a ring — the last 20 000 lines or 8 MiB — and serves it to an ingress bearer whose subject holds `trace:read`:

```bash
# the last 50 GitHub calls, with their trace ids and routes
curl -sS -H "authorization: Bearer $SWITCHBOARD_INGRESS_TOKEN" \
  "$SWITCHBOARD_BASE_URL/admin/trace/log?span=github&limit=50"
# everything one run did, from its run_meta.traceId
curl -sS -H "authorization: Bearer $SWITCHBOARD_INGRESS_TOKEN" \
  "$SWITCHBOARD_BASE_URL/admin/trace/log?traceId=<32 hex>&limit=5000"
# what ended in the last ten minutes
curl -sS -H "authorization: Bearer $SWITCHBOARD_INGRESS_TOKEN" \
  "$SWITCHBOARD_BASE_URL/admin/trace/log?since=$(( $(date +%s) * 1000 - 600000 ))"
```

The answer is `{ ok, lines, matched, kept, dropped, oldestAt }`: `lines` oldest first (the newest `limit` of what matched), `dropped` how many the ring has let go since the container started, `oldestAt` how far back it reaches. Filters: `since` (epoch ms, on the span's end), `traceId`, `span` (a name, or a family: `github` matches `github.rest` and `github.token_mint`), `limit` (500 by default, 5 000 at most). A malformed filter is a 400; no bearer is a 401; a bearer without `trace:read` is a 403. The ring empties with the container, so read before you deploy. The contract is [Tracing](../reference/specs/tracing.md).

## What you did

You read the bot's state before acting, deployed through the one runner with its preflights, changed config or a secret with a put and a restart, and read the span log. Why "deployed" is not "live" and why the order is fixed: [the decision record](../decisions/0015-deploy-order-deployed-is-not-live.md).

## For this installation

The project's own production is one installation of the product. These facts belong to it, not to Switchboard:

- The profile and the bot's config live in a private infrastructure repository. The workflows read its location from the repository variable `SWITCHBOARD_DEPLOY_PROFILE` (a `github://…@main` reference) and mint a read-only App token for it as `CONFIG_REPO_TOKEN` — the App's credentials are the one step in the workflows that is this installation's; from a laptop, export the same two variables.
- CI holds `CLOUDFLARE_DEPLOY_TOKEN` (Workers Scripts, Containers, R2 and Account Settings at the account; Workers Routes and DNS at the zone), `RESIDENT_READ_TOKEN` and `SANDBOX_TOKEN`; the docs deploy uses `CLOUDFLARE_API_TOKEN`, which is also the fallback while no deploy token is set. Rotation: [Rotate a secret](rotate-a-secret.md).
- The deployment is mapped into an external infrastructure graph. Cloud resources sync from the provider on their own; the cross-Worker call paths (bot → state Worker, bot → resident Worker, bot → sandbox Worker, all `invokes`) are asserted edges that go stale silently, so a change that adds, removes or repurposes a Worker, a Durable Object or a call path asserts the delta there in the same change cycle.
- The docs site is public on the project's docs domain. An installation that wants its docs private puts Cloudflare Access in front of the docs Worker; the project's own has none.
