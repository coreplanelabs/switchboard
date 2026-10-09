# Model-capacity benchmarks

Read this before changing model concurrency, parsing permits, queue waiting or bot sizing. The [architecture](../../../explanation/model-call-flow.md) explains the resources; [decision 0098](../../../decisions/0098-bound-stream-concurrency-separately-from-parsing.md) explains the policy. The settings live in `src/core/budgets.ts` as `RESPONSES_VALIDATION_LIMITS`.

## Fixed workloads

| Profile | Callers | Calls per caller | Expected outcome |
|---|---:|---:|---|
| `team` | 20 | 2, sequential | Five engineers with four threads each: every response exact, no header queue |
| `burst` | 64 | 2, sequential | Every response exact; overflow waits within the configured queue |

Both send768KiB requests and128KiB response frames, hold960MiB as a gateway baseline, and use a1-second fake-provider delay. The child runs the compiled checkout through real local HTTP. External network access is disabled; no real provider, customer request or deployment is used.

## Run and compare

Install dependencies and have Docker running. The baseline's runtime image must be cached. The command builds the current checkout, uses the bot template's CPU/memory size and disables swap. To use a different cached runtime, pass `--image`; to test a different quota, pass `--cpu` and `--memory-mib`. Docker must support platform-specific image inspection.

On a fresh machine, build the runtime dependency stage from this checkout. It uses the Node version pinned in the repository Dockerfile and does not publish an image or start the bot:

```sh
docker build --platform linux/amd64 --target deps -t switchboard-model-capacity:local .
npm run load -- model-capacity --profile team --image switchboard-model-capacity:local --baseline docs/reference/benchmarks/model-capacity/team.json
npm run load -- model-capacity --profile burst --image switchboard-model-capacity:local --baseline docs/reference/benchmarks/model-capacity/burst.json
```

The tracked receipts retain the original qualification image reference. Rebuilding creates a different image identity, so comparisons correctly withhold timing deltas until a new baseline from that image is recorded. The checkout's compiled code and dependencies are mounted read-only; no cached image's application code is reused. On a machine with the original qualification image cached, omit `--image` to reuse the receipt's reference.

The baseline supplies its recorded image reference unless overridden. A missing or wrong-platform cached image is a prerequisite failure; select or build a matching runtime explicitly. The image ID, Node version, architecture, hardware and quotas remain in the receipt. A changed environment is not a like-for-like timing comparison.

Each run writes new JSON and Markdown files under `load-results/` (gitignored), never overwriting earlier runs. Failures remain recorded. A process that exits without a complete receipt gets a separate failure record; no missing measurements become zeroes or successful cleanup. Keep both files with the change's verification evidence. Promote a successful receipt here only after verifying its source fingerprint and checks; retain the prior dated receipt when replacing a baseline.

## Relate measurements to settings

| Setting | What changes | Read these measurements |
|---|---|---|
| `workers` | Active whole-response exchanges | Peak active, throughput, call latency, memory |
| `queued` | Waiting unread requests | Peak queued, failures and queue-wait percentiles |
| `queueWaitMs` | Maximum wait before local refusal | Queue waits and capacity failures |
| `parsers` | Concurrent short processing steps | Call latency, health latency and temporary storage |
| Byte/graph/heap/storage limits | Independent safety boundaries | Exact responses, refusal reasons, memory and final credits |
| Bot `instance_type` | CPU and memory quota | Cgroup quota, health latency, throughput, peak memory |

The receipt records the actual loaded settings, fixed workload, source revision and per-file fingerprint, runtime image and environment, raw per-call samples, p50/p95/max call and queue/health timings, occupancy, memory, checks and final credits. Source files changing during measurement fail the result.

`--baseline` names settings changes. It emits timing deltas only when workload and runtime/quota match. Settings changes are allowed in a comparison because they are what the experiment measures. Changing workload or hardware starts a new comparison group. Read the failure counts alongside latency: dropping calls can make timings look faster.

## Acceptance and limits

Pass requires every expected response to match, one upstream request per call, target concurrency, no team header queue, health responses below one second, cgroup telemetry, no OOM, and all transport/storage credits returned. Heap limits and managed-storage credits are not total RSS guarantees. Simultaneous maximal payloads may still be refused by safety limits.

This measures the model proxy, not whole-bot startup, workspace attach, tool execution, model reasoning, SDK task acceptance or Slack/GitHub delivery. Cold worker startup and the fixed fake-provider wait are included in call latency. Emulated Linux timings do not establish native-hardware or natural-provider latency.

## Recorded evidence

- [Team baseline](team.json): measured settings and passing twenty-caller workload.
- [Burst baseline](burst.json): measured settings and passing sixty-four-caller workload.
- [Earlier half-vCPU failure](team-standard-1-failed.json): every response matched and no team request queued, but a health response exceeded one second. This predates the final image-reference metadata; preserve it as historical evidence, not an interchangeable timing baseline.

Adaptive concurrency remains deferred. Repeat both profiles when changing the source policy, then qualify staging and production separately.
