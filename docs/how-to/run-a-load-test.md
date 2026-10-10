# Run a load test

A receipt per surface, before and after a capacity change.

**You need:**

- A checkout: `npm run load` writes each receipt under `load-results/` (gitignored) and exits non-zero when a check fails.
- A quiet window: the resident command refuses to start while the resident has work in flight.
- The bearer per target (`MEMORY_TOKEN`, `RESIDENT_OPERATOR_TOKEN`, `RESIDENT_ADMIN_TOKEN`, `SANDBOX_TOKEN`, an ingress token).

## Offline model-call capacity

The [model-capacity benchmark guide](../reference/benchmarks/model-capacity/README.md) has fixed team/burst workloads, tracked baselines and settings-aware comparisons. Run both before changing model concurrency or bot sizing. It needs Docker and dependencies, but no credentials or quiet production window.

## Measure the baseline

```
MEMORY_TOKEN=<token> SWITCHBOARD_STATE_WORKER_URL=https://memory.example.com npm run load -- history
```

The peak of simultaneously live runs and duration percentiles; every later receipt is compared against it.

## Load one resident

```
SWITCHBOARD_RESIDENT_URL=https://resident.example.com \
RESIDENT_OPERATOR_TOKEN=<token> RESIDENT_ADMIN_TOKEN=<token> \
npm run load -- resident --resource repo:acme/api --threads 16 --hold 600 --cpu-seconds 60 --profile coding
```

Sixteen synthetic threads attach, loop (read, exec, CPU burn, write), detach and are purged. Checks:

- attach p50 ≤ 15 s and p95 ≤ 60 s
- a trivial exec p95 ≤ 3 s
- zero `mirror-busy`, `user-pool-exhausted` or `disk-pressure` refusals

## Load the cold sandbox fleet

```
SWITCHBOARD_SANDBOX_URL=https://sandbox.example.com SANDBOX_TOKEN=<token> \
npm run load -- sandbox --threads 8 --hold 300 --cpu-seconds 60
```

The first command per thread (`first-exec`) is the cold start. Past the fleet's `max_instances` a thread waits for a seat (`fleet-busy`). Exceeding either pool needs `--override`.

## Load the seeded sandbox path

A sandbox seeded from a resident's snapshot restores the checkout and its installed dependencies before the run's first command (execution items 25–26). Point the sandbox load at a resident that has a snapshot:

```
SWITCHBOARD_SANDBOX_URL=https://sandbox.example.com SANDBOX_TOKEN=<token> \
SWITCHBOARD_RESIDENT_URL=https://resident.example.com RESIDENT_OPERATOR_TOKEN=<token> \
npm run load -- sandbox --seed-from repo:acme/api --threads 8 --hold 30 --cpu-seconds 5 --stagger 60
```

Every thread calls `POST /seed` with the handle the resident's `/status` publishes, then runs the same loop as the cold fleet. The receipt is written as `seeded-<runId>`; its rows are the seed's anatomy:

| Row | What it measures |
|---|---|
| `seed` | the whole seed as the run sees it: the container's start, both restores, the fix-up |
| `seed-restore`, `seed-deps` | the checkout archive and the deps entry archive, each restored onto the disk |
| `seed-checkout-download` / `-extract`, `seed-deps-download` / `-extract` | each restore split: the presigned download of the archive, then `unsquashfs` onto the disk |
| `seed-fixup` | ownership, origin, the thread's ref fetched and checked out |
| `first-exec` | the first command on the seeded container |

Checks: `seed` p95 ≤ 90 s (the D4 gate at N = 24 on the largest repository) and zero `seed-missing`, `seed-failed`, `seed-unconfigured` — a Worker without the resident's R2 token answers the last one, and every run then falls to the cold path.

The gate needs a quiet window: 24 seeded threads take 24 of the fleet's 25 seats, so a real run started meanwhile waits behind them. Read `GET /healthz` on the bot for `inFlight: 0` first; a release deploy during the run replaces the containers under it, so check the release train too. The seed's own log lines (`sandbox.seed-restore`, `sandbox.seeded`, `sandbox.seed-failed`) come from `npx wrangler tail switchboard-sandbox --format json` started before the run.

Reading a receipt: a seed's median on the largest repository is about a minute — the container start a few seconds, the checkout restore under ten, the deps archive's download about ten, its extraction twenty to forty, the fix-up a few — so the extraction of the dependency view owns the seed and its tail. A thread whose `seed` is minutes while its restore rows are ordinary spent the difference waiting for the platform to grant it a container: the Worker's `sandbox.starting` / `sandbox.start-failed` / `sandbox.started` lines for that thread say how long and why.

## Run the whole bot at N

The scripted model never calls a real provider.

```
npm run load -- provider --profile coding --cpu-seconds 60
```

```yaml
# the bot's config.yaml; start it with `npm run dev`
providers:
  scripted:
    type: openai-compatible
    baseUrl: http://127.0.0.1:8089
defaults:
  models:
    coding: scripted/any
```

```
SWITCHBOARD_LOAD_INGRESS_TOKEN=<token> \
npm run load -- e2e --ingress-url http://127.0.0.1:8080/ingress --healthz-url http://127.0.0.1:8080/healthz \
  --text "agent:coding in acme/api: load harness" --threads 50 --hold 600
```

`/healthz` is sampled every 15 s for in-flight runs, RSS, heap and event-loop lag. Nothing is pushed or opened: the default profile never calls `submit_pr_description`.

### Check concurrency evidence

`--threads 100` requests concurrency; it does not measure it. On a dedicated bot with no customer work, add `--capacity` and explicit limits:

```sh
SWITCHBOARD_LOAD_INGRESS_TOKEN=<disposable-token> \
npm run load -- e2e --ingress-url http://127.0.0.1:8080/ingress --healthz-url http://127.0.0.1:8080/healthz \
  --text "agent:coding in acme/api: load harness" --threads 25 --hold 300 --stagger 30 \
  --capacity --sampled-span 60 --health-every 5 --max-rss-mb 3000 --max-lag-ms 100 --max-health-ms 500
```

These are example qualification limits, not measured production guarantees. Run stages 25, 50 and 100 separately; advance after the preceding receipt passes. Keep the workload, build, machine size and limits fixed between stages. The receipt requires:

- every requested thread completing successfully, without abort or driver errors;
- overlapping client requests reaching the requested count;
- server `inFlight` reaching that count over a consecutive sampled span, while client requests overlap throughout the same interval, with no polling gap longer than twice the polling interval;
- complete successful health reads, an unchanged process start and build, no drain, and RSS, event-loop lag and health-response time within the supplied limits.

Server `inFlight` includes other work, so a shared bot cannot establish this evidence. Polls measure sampled occupancy; they do not prove continuous occupancy between reads. Record health samples and the interval with the receipt. A restart, missing telemetry, brief peak or queued server fails even if every request eventually succeeds. Ordinary e2e mode retains its zero-failed-run check.

A probe's server observation happens between its local request start and receipt. The credited span is the last probe's start minus the first probe's receipt, clamped at zero. Client overlap must cover the entire probe windows and intervening time. Each possible observation gap is bounded by the current receipt minus the previous probe start. Variable response latency therefore cannot make the receipt claim a longer sampled span than the evidence supports.

Run separate qualifications for 100 concurrent cold starts and 100 CPU-heavy builds. HTTP ingress produces no Slack cards; use `load cards` for the local delivery simulation, then obtain authorized real Slack delivery evidence. Scripted calls do not establish provider rate or token quotas. Ledger write latency, durable endings, recovery and cleanup need their own receipts.

Before a production stage, agree on the disposable scope, served build/config, workload and duration, provider quotas, resource limits, stop conditions, preservation and reclamation owner, and maximum cost. Local success does not authorize production load, resizing or deployment. Final acceptance names actual peaks, sampled duration, setup and interaction latency, failures, recovery, resource headroom and cost.

## Ask what Slack does with fifty cards

```
npm run load -- cards --cards 50 --hold 600 --channels 5
```

A virtual-time simulation of the real status coalescer and budget against a fake Slack API at the published limits: update lag, edits held back or refused, terminal frames landed.

| Flag | Effect |
|---|---|
| `--client retrying` | the same cards without the budget: the baseline |

Post the receipt on the change's PR; never commit `load-results/`.

## Next

- [Load harness](../reference/specs/load-harness.md): the contract.
- [Capacity and sizing](../explanation/capacity-and-sizing.md)

## Check the configured front door before deployment

```
DOOR_SMOKE_TRUSTED_ORIGIN=https://api.openai.com npm run load -- route --smoke --profile-model
```

The deployment profile supplies the config source. Set its provider key in the configured environment variable. This gate uses the same resolved `operator` model, effort, reasoning output budget and preset settings as production. It exercises typed routing without starting agents or writing to the run store. The configured provider must use the trusted HTTPS origin; redirects and requests to other origins are refused.
