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
