# Run a load test

Get a number, not a feeling, for how OpenSwitchboard behaves with many runs at once — before and after a capacity change.

The harness is `npm run load`. Each command writes a JSON result and a markdown receipt under `load-results/` (gitignored), prints the receipt, and exits non-zero when one of its checks fails. It measures infrastructure only: the end-to-end command drives the bot with a scripted model that never calls a real provider.

## Before you start

- A quiet window. The resident command refuses to start while the resident reports work in flight, because a load run on a busy resident measures neither.
- The bearer for each target you load: `MEMORY_TOKEN` for the run store, `RESIDENT_OPERATOR_TOKEN` and `RESIDENT_ADMIN_TOKEN` for a resident, `SANDBOX_TOKEN` for the sandbox fleet, an ingress token for the whole bot.

## 1. Measure the baseline

```
MEMORY_TOKEN=… SWITCHBOARD_STATE_WORKER_URL=https://memory.example.com npm run load -- history
```

This pages the run store and reports the peak number of simultaneously live runs (overall and per day) plus duration percentiles. Every later receipt is compared against this number.

## 2. Load one resident

```
SWITCHBOARD_RESIDENT_URL=https://resident.example.com \
RESIDENT_OPERATOR_TOKEN=… RESIDENT_ADMIN_TOKEN=… \
npm run load -- resident --resource repo:acme/api --threads 16 --hold 600 --cpu-seconds 60 --profile coding
```

Sixteen synthetic threads (`load:<runId>:<i>`) attach, then loop: read a file, run a short git command, burn one core for `--cpu-seconds`, write a note under `.load-harness/`, pause. After the hold every thread detaches and the run's bindings are purged from the resident, so nothing is left on the residents page. More than 16 threads (one resident's pool) needs `--override`; the extra attaches are refused by name and the receipt counts them.

The receipt's checks are the budgets a resident is sized against: attach p50 ≤ 15 s and p95 ≤ 60 s under load, a trivial exec p95 ≤ 3 s, and zero `mirror-busy`, `user-pool-exhausted` or `disk-pressure` refusals.

## 3. Load the cold sandbox fleet

```
SWITCHBOARD_SANDBOX_URL=https://sandbox.example.com SANDBOX_TOKEN=… \
npm run load -- sandbox --threads 8 --hold 300 --cpu-seconds 60
```

The first command per thread is what starts the container, so its row (`first-exec`) is the cold start. Past the fleet's `max_instances` a thread waits for a seat (`fleet-busy`); measuring that wait on purpose needs `--override`.

## 4. Run the whole bot at N

Three shells.

1. The scripted model:

   ```
   npm run load -- provider --profile coding --cpu-seconds 60
   ```

2. A bot configured to use it. In its `config.yaml`:

   ```yaml
   providers:
     scripted:
       type: openai-compatible
       baseUrl: http://127.0.0.1:8089
   defaults:
     models:
       coding: scripted/any
   ```

   with an ingress token whose identity may run `coding` against the target repository, then `npm run dev`.

3. The load:

   ```
   SWITCHBOARD_LOAD_INGRESS_TOKEN=… \
   npm run load -- e2e --ingress-url http://127.0.0.1:8080/ingress --healthz-url http://127.0.0.1:8080/healthz \
     --text "agent:coding in acme/api: load harness" --threads 50 --hold 600
   ```

Each thread posts one run at a time and records its terminal status; `/healthz` is sampled every 15 s for in-flight runs, RSS, heap and event-loop lag. The default profile ends with a plain answer and never calls `submit_pr_description`, so the run pushes nothing and opens nothing.

## 5. Ask what Slack does with fifty cards

```
npm run load -- cards --cards 50 --hold 600 --channels 5
```

No network: a simulation in virtual time over the real status coalescer and the real process-wide status budget, against a fake Slack API that enforces the published limits (the Tier 3 budget for `chat.update`, the per-channel rate). It reports card update lag, edits the budget held back, edits Slack refused, terminal frames that waited for a funded slot, and how many cards got their terminal frame. `--client retrying` runs the same cards through the adapter without the budget (the Web API client's own retry-after loop), the baseline the budget is measured against. `--per-app-per-minute 1000000` lifts the limits to see the budget alone; `--budget-per-minute N` moves the budget's rate.

## What you did

You produced a receipt per surface, each one comparable to the baseline and to the next run after a change. Keep the markdown receipt with the change it measures — a comment on its pull request — and never commit `load-results/`. What each command measures and checks is the contract in [Load harness](../reference/specs/load-harness.md); why the resident is sized the way it is: [Capacity and sizing](../explanation/capacity-and-sizing.md).
