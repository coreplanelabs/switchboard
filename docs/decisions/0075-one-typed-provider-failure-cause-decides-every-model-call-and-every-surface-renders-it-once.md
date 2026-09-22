---
title: One typed provider-failure cause decides every model call and every surface renders it once
status: accepted
date: 2026-09-22
pattern: Classify provider answers once at the provider boundary; consumers act on a closed cause and people see one cause-owned sentence, never provider prose
---

# One typed provider-failure cause decides every model call and every surface renders it once

**The ask.** Fix issue #2170 as one architectural boundary rather than another status-code exception. Every model call — a run through the model proxy, the harness retry ladder, the door's intake verdict and memory reflection — must receive one typed provider failure. A consumer decides from the cause, not from provider prose. Written for an engineer who knows the provider card, model proxy, harness and plane. Success means:

1. The closed causes are `transient`, `rate-limited`, `credit-or-quota-exhausted`, `key-absent`, `key-invalid`, `model-unknown`, `request-rejected` and `permanent`.
2. Status plus structured provider body is classified once. A 402 carrying `limit_source`, and another provider's equivalent quota code, is provider-down exactly as a 5xx is.
3. A provider-down run keeps its held turn under the run lease. The proxy reports the down cause, the plane parks the run, and a successful probe or model call releases the held turn. Account exhaustion does not become a run failure.
4. One cause has one sentence on every person-facing surface. A payload, provider URL or recovery instruction never enters that renderer.
5. The door does not fail silently when its intake model fails: it stores the typed cause and posts the same calm sentence once.
6. Operators can see a configured key's provider-reported limit and remaining credit before zero, with one warning below the day's typical spend.
7. A configured provider whose `apiKeyEnv` is absent is refused by `deploy config`, naming the variable. Required secrets derive from configured provider references rather than a static list.

## TL;DR

Provider health is a fact, not a phrase search. A single `ProviderFailure` boundary classifies each failed answer into eight causes; runs park on provider-down causes, all consumers act on the cause, and one renderer prevents wire payloads and provider URLs from reaching people. The first cut lands the type, matrix, proxy, pi harness, intake and reflection consumers. Later cuts add the probe and plane card, credit telemetry, and configuration-time key refusal.

## Today at `b43af4a5`

| Call path | Decision before this record | Failure |
| --- | --- | --- |
| `src/channels/modelProxy.ts` | Retries and parks 408, 425, 429 and 5xx by status plus HTML by content type | The incident's 402 bypasses the provider-down path and is relayed as raw JSON. |
| `src/core/harness/pi/harness.ts` | `isTransientProviderError` and `isParkedProviderError` search the adapter's prose | New provider wording can change whether a turn retries, parks or ends. |
| `src/core/intake.ts` | Any throw becomes `silent/error` with `intake model failed: <message>` | A new reply can disappear during a provider outage and the payload becomes receipt text. |
| `src/core/dispatch/operator.ts` | A thrown model call becomes `non_decision` | The door falls through to `general`; the 06:36Z OpenAI schema 400 routed a review ask to the wrong agent. |
| `src/core/memory/reflection.ts` | The background pass catches and logs an arbitrary error message | It has no shared cause with the run or intake paths. |
| `src/core/commands/providers.ts` | Checks model-card endpoint drift | It does not read a key's limit, usage or remaining credit. |
| deploy configuration and secret manifests | Required/optional keys come from static expectations | A configuration can name a provider whose key is absent and fail only on its first call. |

The duplication is the bug. A status list in the proxy and a prose list in the harness can disagree even when both are individually correct. Direct provider calls then invent a third and fourth policy.

## The shape

### The seam

`ProviderFailure` is an `Error` whose `cause` is the closed set above. It may retain structured operator metadata — status, provider, model and an extracted operator URL — but its `message` is always `renderProviderFailure(cause)`. It never retains a raw payload as a renderable field.

`classifyProviderFailure` is the only decoder. It reads status and structured wire fields such as `cause`, `code`, `type` and `limit_source`; only adapter failures that expose no structured answer reach its bounded transport decoding. Unknown answers are `permanent`, never guessed transient. A new cause changes the type, matrix and renderer together.

The provider-down set is deliberately smaller than the cause set: `transient`, `rate-limited` and `credit-or-quota-exhausted`. Key, model and permanent failures do not retry forever. The proxy reports `{provider, side: down, cause}`, parks the run and relays only a wire-shaped `provider_failure` containing the cause and renderer sentence. A success reports `up` and releases the parked turn through the existing plane mechanism.

### The renderer

`renderProviderFailure` is total over the cause union and returns exactly one sentence. The function accepts no body, URL, provider message or suggested remedy, making payload leakage impossible by construction. The provider's key-management URL is operator metadata for the later admin card; it is not a thread, CLI or run-page link.

The intake receipt carries `providerFailure` beside `source: error`. The first deciding process posts the rendered sentence and does not dispatch the reply. A replay reads the same typed receipt; it does not reconstruct a cause from the stored reason. The operator records a provider refusal with that typed cause, renders it once and stops at the door instead of falling through to `general`. Memory reflection logs the rendered cause and writes nothing.

### Operational facts

A later probe owns recovery, not a person. It calls through the provider boundary; a successful answer changes the provider to `up` and reissues every held turn. The plane health card names one down cause once and may show operator-only account metadata.

`providers check` gains account credit facts from the provider's own key endpoint. For OpenRouter that is `GET /api/v1/auth/key` with `limit`, `usage` and `limit_remaining`. The command and plane panel use the same normalized account row and emit one warning when remaining credit is below the measured typical daily spend.

Configuration is the earlier door. Every provider block reachable from defaults, intake or memory contributes its `apiKeyEnv` to the required-secret manifest. `deploy config` refuses a missing required key by variable name. A keyless local provider remains legal because its block declares no key variable.

A request-shape 400, including the 06:36Z OpenAI `invalid_json_schema` answer from issue #2188, is `request-rejected`. It is not provider-down, so the run or door ends once with the safe cause sentence; the operator never converts it into `non_decision` and never routes the original ask to `general`.

## One hard-case trace: the 21:24Z credit-limit answer

1. A live run's proxied call receives HTTP 402 with a structured `metadata.limit_source` naming the provider key limit. The body also contains a long explanation and a key-management URL.
2. `classifyProviderFailure` returns `credit-or-quota-exhausted`, retaining the status and operator URL outside the renderer. No caller scans the explanation.
3. The proxy spends its one immediate retry. If the cause stands, it posts provider `down` with that cause, parks the run on `provider_up(provider)` and answers the harness with a wire-shaped error whose message is the one safe sentence.
4. The pi bridge attaches the typed cause. The harness sees a provider-down cause, keeps the current turn held, and runs its backoff while the run lease, stops and inbox remain live. It never sees the original body or URL.
5. An intake call in the same outage receives the same cause. The receipt is `silent/error` for dispatch purposes but carries the cause, and the channel posts its one sentence; the person's reply is not invisibly discarded.
6. A provider probe eventually succeeds. The plane changes to `up`, emits one reissue steer per parked live run, and each harness continues its held turn. No replacement request from a person is needed.
7. The operator's health surface can show the cause, key-management link and normalized account credit. Person-facing surfaces still have only the cause sentence.

The trace's invariant is end to end: the provider payload is useful for classification and operator metadata, never for control flow after the seam and never for person-facing prose.

## The difficulty map

1. **Adapter normalization.** Providers express the same fact through different status/body combinations. The matrix must contain one row per supported answer and default unknown combinations to `permanent`.
2. **The HTTP boundary.** A run's harness is another process, so the typed cause must survive a provider-shaped response without smuggling the original body. The proxy's `provider_failure` envelope is the transport form of the type.
3. **Abort ownership.** A deliberate tool-cut or wind-down abort belongs to the run, while an ordinary open-stream abort is transient provider failure. The run's known abort is decided before provider recovery.
4. **Park lifetime.** A held turn must remain under its run lease, react to stops and inbox events, and release once. The existing durable park and sequence-deduped steer remain the mechanism.
5. **Exactly-once visibility.** A down transition can be observed by many calls. The plane owns one durable provider row and one card; individual runs do not each announce the outage as a new fact.
6. **Safe operator metadata.** A URL extracted from untrusted provider text may be useful to an operator but must never be accepted by the user renderer. Separate fields and surfaces enforce that split.
7. **Required secrets from reachability.** Defaults, intake and memory may name different blocks. The deploy check must resolve the same effective references as runtime without making intentionally keyless local providers invalid.
8. **Spend threshold semantics.** “Typical day” must come from the existing cost history with a documented empty-history fallback; it cannot be an arbitrary constant hidden in the command.

## Why not X

**Why not add 402 to the proxy list?** That fixes one incident but leaves direct intake and reflection calls, the harness prose list and provider equivalents inconsistent.

**Why not make every 4xx permanent and every 5xx transient?** Quota and rate limits are provider availability, while key and model failures need operator correction. Status alone does not carry enough meaning.

**Why not pass the provider's message through after attaching a cause?** The message is untrusted, unstable and can contain URLs or instructions. Keeping it available to renderers would preserve the leak the type is meant to remove.

**Why not tell the person to raise the limit or retry?** Recovery is the plane's responsibility. A person-facing instruction delegates an operation the product can observe and resume itself.

**Why not require every possible provider key?** Configuration names what the deployment uses. A static manifest both misses new blocks and over-requires unused providers; reachability through `apiKeyEnv` is the source of truth.

## Boundaries

This record does not change model-card resolution, run lease arithmetic, provider credentials in execution containers, authorization, the harness gate, or the merge door. It does not make a raw provider body user-visible for debugging. Existing operator logs and traces may carry bounded structured metadata, subject to their current credential redaction.

The first implementation cut does not ship OpenCode's held-execution release, account probes, the final plane card, credit warning or deploy-config refusal. It makes their inputs typed and durable. Until the probe cut lands, recovery still requires another successful proxied call to produce `up`; that is rollout state, not the final contract.

## Rollout

1. **Typed seam and first consumers.** Add the cause union, classifier matrix and one renderer. Move the proxy, pi retry ladder, intake and reflection to it. Persist the down cause and prove a 402 parks; remove the harness prose classifiers.
2. **Probe and plane card.** Probe a down provider under a bounded schedule, persist operator metadata, render one health-card cause, and resume all parked turns on success.
3. **Credit visibility.** Normalize provider key-account facts, add OpenRouter's key endpoint to `providers check`, show the same row on the plane panel and warn once below typical daily spend.
4. **Configuration-time key refusal.** Derive required key variables from reachable provider blocks, update the secret manifest split, and make `deploy config` fail closed by variable name.

Operational receipt after the recovery cut: on `worker:bot` at or beyond the merge containing that cut, make a live provider answer 402 or 5xx; the run parks without ending, the plane names the cause once, and a successful probe resumes the held turn.

## Sources

- Issue #2170: the 21:24Z credit-limit outage, raw-payload rendering failure and generalized model-call seam.
- Infrastructure issue 139: a configured provider key must be required at deploy configuration time.
- [Record 0064](0064-the-plane-owns-every-runs-state-a-refusal-becomes-a-queue-position-an-ending-is-judged-by-the-ledger-that-saw-it-and-a-release-is-a-quiet-window-a-person-closes.md): provider parks, durable effects and run leases.
- [Record 0067](0067-one-seam-for-a-structured-answer-a-violation-is-re-asked-with-the-violation-named-and-the-callers-declared-floor-holds-never-a-refusal-shown-to-the-person.md): structured model answers and caller floors.
- [Record 0072](0072-a-run-has-one-live-state-owned-by-the-server-a-closed-set-one-event-one-wording-function-and-every-surface-reads-the-one-field.md): closed causes and one wording function.
- `src/channels/modelProxy.ts`, `src/core/harness/pi/harness.ts`, `src/core/intake.ts`, `src/core/memory/reflection.ts` and `src/core/provider.ts` at `b43af4a5`.

## Public hygiene

This record retains the public issue numbers, the incident minute and a shortened public-tree SHA because they make the decision auditable. It includes no credential, account identifier, full key URL, private conversation identifier, customer name or raw provider payload.
