# Run visibility

You can see what an agent is doing while it works, in real time (Area 2 / R12). The runner emits a typed stream of **run events** — each tool call and a redacted one-line summary of its result — and the Slack status card now updates **live on every event** instead of only on the 5-second heartbeat, so activity is visible as it happens rather than feeling stalled between checklist updates. Secrets are stripped before anything enters the stream. This is the foundation the external live-view page (the chosen next step) will consume.

- **Code**: `src/core/runEvents.ts` (the `RunEvent` type, `redactSecrets`, `summarizeToolResult`); `src/runner.ts` (`RunOptions.onEvent`, emits `tool_call`/`tool_result`); `src/core/dispatcher.ts` (consumes `onEvent` → live card refresh with a one-line activity trace).
- **Tests**: `src/core/runEvents.test.ts`, `src/runner.test.ts` (`run-visibility events`).

## Behavior

1. **Typed run-event stream**: the runner emits `tool_call` (the tool + a summary of the call) then `tool_result` (the tool, `ok`, a redacted one-line summary) for every tool use, via `RunOptions.onEvent` — a small seam so consumers (the status card today, the live page next) never reach into the runner's loop. Wrap-up/budget notices still go to `onProgress` as text **and** (since [#84](https://github.com/coreplanelabs/switchboard/issues/84)) into the stream as typed `run_note` events; every event carries `at` (epoch ms) and an infra-level tool failure is marked `infra: true` — see [run-friction.md](run-friction.md).
2. **Live in-channel card**: the dispatcher refreshes the status card immediately on each event, appending a one-line activity trace (`→ <call>` / `✓|✗ <tool>: <result>`) below the agent's checklist — so progress shows per tool, not only every 5 s. Full command output still goes to stdout for operators.
3. **Secrets never enter the stream**: `redactSecrets` strips known credential formats before summaries leave the process — a safety gate, since the stream is shown in-channel (and, later, on a shared page). Coverage: Slack `xox*`; GitHub `ghp_`/`github_pat_`/`x-access-token:`; Anthropic/OpenAI `sk-*`; AWS `AKIA*` and GCP `AIza*`; Stripe `sk_live_`/`whsec_`; `Authorization: Bearer/Basic/token` headers; `Cookie`/`Set-Cookie` values; URL/connection-string basic-auth (`scheme://user:pass@`) and `curl -u user:pass`; PEM `PRIVATE KEY` blocks; and a **name-gated assignment pass** that hides the value of any `…SECRET`/`…KEY`/`…TOKEN`-style identifier (so `AWS_SECRET_ACCESS_KEY=…` is caught, while `PORT=3000`, `REACT_VERSION=…`, `MONKEY_BARS=…`, SHAs, and digests are not). Redaction always runs **before** length-capping (`redactAndCap`), so a secret near a truncation boundary can't leak as a raw fragment.
4. **Result summaries are bounded**: `summarizeToolResult` returns the first non-empty (redacted) line, capped at 200 chars, with a size note for larger output — enough to see what happened without dumping the payload.
5. **Failures are visible**: a throwing tool emits `tool_result` with `ok:false` and the (redacted) error, rendered with a `✗`.

## Validation criteria

| Criterion | Evidence |
|-----------|----------|
| Runner emits `tool_call` then `tool_result` per tool use | `[unit]` `src/runner.test.ts::run-visibility events::emits tool_call then tool_result for each tool use` |
| Failing tool → `tool_result ok:false` with the error | `[unit]` `::run-visibility events::marks a failing tool with ok:false` |
| Secrets redacted from result summaries | `[unit]` `::run-visibility events::redacts secrets in tool_result summaries`; `src/core/runEvents.test.ts::redactSecrets::*` (redaction red-verified) |
| Result summaries first-line + capped + size note | `[unit]` `src/core/runEvents.test.ts::summarizeToolResult::*` |
| Redaction is conservative (prose/config untouched) | `[unit]` `::redactSecrets::leaves normal text (incl. the word 'token' in prose) untouched`, `::does not over-redact ordinary config / output (no false positives)` |
| Redaction covers realistic env/curl/cloud/connection-string shapes | `[unit]` `::redactSecrets::redacts realistic env / curl / cloud / connection-string secrets` (repro-verified against the review's exact leaked payloads) |
| Redact-before-cap: no fragment leak at a truncation boundary | `[unit]` `::redactAndCap::redacts BEFORE capping — a secret near the boundary never leaks as a fragment`; `src/runner.test.ts::run-visibility events::redacts a secret in a long bash command before capping` |
| Live card refresh per event (perceived-latency fix) | `[agent]` (post-deploy) — pending; observe the Slack card ticking per tool call/result rather than every 5 s. |
| External live-view page consuming this stream | Shipped — see [live-view.md](live-view.md) (per-run capability token + SSE; consumes this same event stream). |
