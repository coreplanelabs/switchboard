# Memory Worker test runtime

The memory Worker suite runs against real SQLite Durable Objects in workerd. Its test runtime must remain stable as the suite creates new objects; a test's own failure must be attributable to that test, not a later case.

- **Code**: `deploy/cloudflare-memory/package.json`, `deploy/cloudflare-memory/vitest.config.ts`, `deploy/cloudflare-memory/tsconfig.json`, `deploy/cloudflare-memory/test-env.d.ts`, `deploy/cloudflare-memory/testDiagnostics.ts`, `deploy/cloudflare-memory/testFetch.ts`.
- **Tests**: `deploy/cloudflare-memory/runLedger.test.ts`, `deploy/cloudflare-memory/runs.test.ts`, `src/memoryWorkerDiagnostics.test.ts`.

## Validation criteria

| Criterion | Proof |
|---|---|
| The Worker suite uses a maintained Cloudflare Vitest integration whose Durable Object wrapper installs one prototype proxy per class, so constructing more objects does not increase lookup depth. | `[agent]` Inspect the installed package's wrapper implementation and compare it with the upstream regression and fix; run `npm test -w deploy/cloudflare-memory` in fresh processes before and after the dependency change, recording duration, case count and any timeouts. |
| Every Worker test case runs in workerd with the same bindings and assertions after the integration changes. | `[agent]` Run the named Worker test files, the Worker typecheck, and current-head CI; compare the test count and failures with the baseline. |
| Large fixture cases retain their data volume and assertions while setup crosses the Durable Object test boundary once per case. | `deploy/cloudflare-memory/runs.test.ts::run history routes::recovery evidence filters before the cap and attests only a complete valid set`; `deploy/cloudflare-memory/runs.test.ts::run history routes::recovery evidence refuses unreadable protected bytes beyond ordinary retention limits`; `deploy/cloudflare-memory/runs.test.ts::run history routes::list: newest-first, limit 1000…`; `deploy/cloudflare-memory/schedules.test.ts::schedule firing routes::is bounded per schedule: the oldest firings fall off past the cap` |
| An intermittent timeout or cross-object I/O failure has an identified originating operation, not merely a passing retry. | `[gap]` A clean run alone cannot prove all intermittent failures are gone. Keep the CI reliability issue open until repeat Linux CI runs and diagnostic artifacts show no recurrence; investigate any new failure at its exact head. |
| A slow cold Durable Object request does not exhaust a multi-request case's deadline; if a case times out during fetch or response-body consumption, the diagnostic names the pending route and completed request durations. | `[unit]` `src/memoryWorkerDiagnostics.test.ts::memory Worker diagnostics::records completed and pending operations when a case times out`; `src/memoryWorkerDiagnostics.test.ts::memory Worker diagnostics::keeps a request pending when its response body stalls`; `[agent]` Run the named Worker test files and repeat the complete memory Worker verify on Linux at the same head. |
