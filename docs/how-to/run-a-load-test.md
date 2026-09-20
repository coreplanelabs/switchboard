# Run a load test

A receipt per surface, before and after a capacity change.

**You need:**

- A checkout: `npm run load` writes each receipt under `load-results/` (gitignored) and exits non-zero when a check fails.
- A quiet window: the resident command refuses to start while the resident has work in flight.
- The bearer per target (`MEMORY_TOKEN`, `RESIDENT_OPERATOR_TOKEN`, `RESIDENT_ADMIN_TOKEN`, `SANDBOX_TOKEN`, an ingress token).

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
