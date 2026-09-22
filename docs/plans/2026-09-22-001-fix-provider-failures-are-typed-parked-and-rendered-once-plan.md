---
title: Provider failures are typed, parked and rendered once - Plan
type: fix
date: 2026-09-22
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
extends: ../decisions/0074-one-typed-provider-failure-cause-decides-every-model-call-and-every-surface-renders-it-once.md
---

# Provider failures are typed, parked and rendered once - Plan

## Goal Capsule

- **Objective**: Implement accepted [record 0074](../decisions/0074-one-typed-provider-failure-cause-decides-every-model-call-and-every-surface-renders-it-once.md): every model call classifies one closed provider-failure cause, provider-down causes park and resume work, people see one safe sentence, operators see account credit before zero, and configured keys fail closed at deploy configuration time.
- **Authority**: record 0074 owns causes, rendering and rollout. [Record 0064](../decisions/0064-the-plane-owns-every-runs-state-a-refusal-becomes-a-queue-position-an-ending-is-judged-by-the-ledger-that-saw-it-and-a-release-is-a-quiet-window-a-person-closes.md) owns leases, provider parks and durable release effects. [Record 0072](../decisions/0072-a-run-has-one-live-state-owned-by-the-server-a-closed-set-one-event-one-wording-function-and-every-surface-reads-the-one-field.md) owns closed cause/rendering shape.
- **Execution profile**: four dependency-ordered code units, one pull request and review each. U1 lands with this record. U2 makes provider recovery proactive and visible. U3 exposes credit facts. U4 refuses missing configured keys before deploy.
- **Stop conditions**: stop before changing behavior if a model call cannot cross `ProviderFailure`; if a user renderer needs the raw provider body or URL; if a provider-down turn cannot remain under the existing run lease; if a probe can start a duplicate turn; if account telemetry requires an inference key to leave the bot; if required-secret derivation would reject an intentionally keyless provider; or if any unit weakens authorization, credential isolation, admission, leases or the harness gate.
- **Tail ownership**: no unit merges autonomously. The operational receipt waits for the bot Worker generation containing U2 or later.

## Product Contract

### Summary

A single provider boundary maps status and structured body to `ProviderFailure.cause`. The cause union is closed: `transient`, `rate-limited`, `credit-or-quota-exhausted`, `key-absent`, `key-invalid`, `model-unknown`, `request-rejected`, `permanent`. Consumers act on that field. `transient`, `rate-limited` and `credit-or-quota-exhausted` are provider-down; the proxy parks the current run and the harness holds its turn. Every person-facing surface calls one renderer that returns one sentence and receives no payload or URL.

The plane later probes a down provider and resumes parked turns on success. The operator's health view may show the extracted key URL and normalized account credit. `providers check` reads provider key-account endpoints and warns once when remaining credit is below typical daily spend. `deploy config` derives required key variables from the configured model references and refuses missing values before rollout.

### Requirements

**U1 — typed seam and first consumers**

- R1. `ProviderFailure.cause` and `PROVIDER_FAILURE_CAUSES` contain exactly the eight accepted causes. `classifyProviderFailure` is total over status, structured body and adapter transport errors. Unknown input is `permanent`.
- R2. `src/core/providerConformance.test.ts` contains the failure matrix with at least one provider answer per cause, including the 21:24Z OpenRouter 402 body with `metadata.limit_source: openrouter_key_limit` and the 06:36Z OpenAI schema 400 from issue #2188 as `request-rejected`.
- R3. `renderProviderFailure` is total and one sentence per cause. Its input is only the cause. A renderer-wide fixture rejects JSON payload markers, an external URL and a recovery instruction in every output.
- R4. The model proxy classifies every failed response. Provider-down causes receive the one immediate retry, report `down` with cause, persist that cause in the plane level row, park the run and cross the HTTP boundary as a provider-shaped `provider_failure` containing only cause and rendered sentence. Success reports `up`.
- R5. The pi bridge attaches `ProviderFailure`; the harness retry ladder consumes `cause`. The old transient/park prose classifiers are absent. Intentional tool-cut and wind-down abort ownership remains before provider recovery.
- R6. Intake stores the typed cause on its receipt and returns the one sentence. The live Slack door posts it once before returning without dispatch. The operator records and renders a typed provider refusal rather than returning `non_decision`; no provider failure falls through to `general`. Neither path includes the provider body or URL.
- R7. Memory reflection consumes a typed failure, logs the renderer sentence and writes nothing.
- R8. Update exact rows in `model-proxy.md`, `harness-pi.md` and the harness contract. The record is accepted in this pull request.

**U2 — proactive probe, one plane card, durable resume**

- R9. A provider `down` row schedules one bounded probe keyed by provider and cause. Duplicate failures update facts but do not start another probe or card.
- R10. The probe uses the provider boundary and the configured provider/model without a run turn, under an explicit budget and backoff. A success atomically writes `up`, cancels the probe and offers one sequence-deduped reissue steer per parked live run.
- R11. A persistent provider-down answer updates the cause and next probe without ending parked runs. Pi and OpenCode both preserve the typed cause through their event bridges, hold the failed model turn/execution and accept the plane's release; key, model and permanent causes do not enter the provider-down probe loop.
- R12. The plane health card says the cause once where operators look. Operator-only metadata may include the extracted key-management URL. Thread, CLI answer, run card and run page keep the renderer sentence and no provider URL.
- R13. A bot roll rehydrates down provider rows, open probe state and parks. It neither drops parked turns nor probes twice.
- R14. The live receipt uses a test provider: 402 parks all affected turns; a later successful probe resumes each once; no run ends from the provider cause.

**U3 — provider account credit in checks and health**

- R15. Add one normalized `ProviderAccountCredit` row: provider/block, optional limit, usage, remaining and fetched-at, with no key value.
- R16. OpenRouter reads `GET /api/v1/auth/key` using the configured key and maps finite `limit`, `usage` and `limit_remaining`. A malformed or failed account response is that provider's typed error line, not failure of the whole command.
- R17. `providers check` prints limit and remaining for every configured key whose provider exposes account facts. The plane health panel reads the same normalized row.
- R18. Typical daily spend comes from the existing cost history over a documented window. One warning appears when positive remaining credit is below that value; no history yields a named unavailable threshold rather than a guessed constant.
- R19. Account reads are bounded, redacted and cached enough that opening the health panel does not call the provider directly.

**U4 — configured keys fail closed at deploy configuration**

- R20. Resolve every provider block reachable from default agent models, intake and memory through the same model-ref parser runtime uses. Each reachable block's declared `apiKeyEnv` is required.
- R21. An Anthropic block without `apiKeyEnv` contributes `ANTHROPIC_API_KEY`; a keyless compatible/local block contributes none. An unused configured block is optional unless another production path references it.
- R22. `deploy config` refuses when a required variable is absent, naming the variable and provider block before any deployment write. This is the bare-config restart's fail-closed shape, not a first-call failure.
- R23. The generated secret manifest's required/optional split comes from that derivation. Static provider-key lists retire. Generated files change only through their generator.
- R24. Carry the scoped requirement from infrastructure issue 139 without broadening deploy authorization or revealing secret values.

### Scope Boundaries

- No new provider SDK. HTTP reads use existing provider/fetch seams.
- No provider key enters a run container, Worker or user response.
- No run lease is widened. A parked turn remains a live run state governed by the existing lease and stop controls.
- No raw provider body is added to the run record, intake receipt, plane card or health response. Bounded operator logs may retain already-authorized structured metadata.
- U1 does not claim proactive recovery, account credit or deploy-time key refusal. Those are U2–U4.
- U3 does not auto-purchase credit or mutate provider account settings.

## Planning Contract

### Key Technical Decisions

- **K1. Type at the provider boundary.** Proxy and in-process adapters construct `ProviderFailure`; every downstream branch switches on `cause`.
- **K2. Transport the type, not the body.** The model proxy's provider-shaped error carries `type: provider_failure`, `cause` and the rendered sentence only.
- **K3. Persist cause with health.** A provider level row stores its typed down cause so the card and probe do not reconstruct it from logs.
- **K4. Render from the cause alone.** The single renderer's signature prevents payload and URL interpolation.
- **K5. Probe is provider-scoped.** One provider probe releases all its parked runs through existing durable effects; no run owns an outage probe.
- **K6. Credit is one normalized read model.** Command and plane panel consume one account row rather than call provider endpoints independently.
- **K7. Required secrets follow effective references.** The manifest and deploy validator use runtime model resolution, not a hand-maintained key list.

### Sequencing

U1 → U2 → U3 and U1 → U4. U3 depends on U2's provider health row for the plane panel, but the command-side account reader may be developed independently on U1. U4 depends only on U1's provider vocabulary and may proceed after U1. The operational park/resume receipt belongs to U2.

## Implementation Units

| U-ID | Title | Key files | Depends on |
| --- | --- | --- | --- |
| U1 | One typed cause reaches proxy, harness, intake and reflection | `src/core/provider.ts`, provider matrix, model proxy, pi bridge/harness, intake/Slack, memory reflection, plane level row | none |
| U2 | A provider probe resumes every parked turn and the plane says why once | plane decider/state Worker, probe service, bot wiring, plane service/panel, run records | U1 |
| U3 | Provider checks and health show key limit and remaining credit | providers command, account readers, cost history, plane health projection/UI | U2 |
| U4 | Deploy config refuses a configured provider with no key | provider-ref reachability, deploy config, secret manifest generator and deploy tests | U1 |

### U1. One typed cause reaches proxy, harness, intake and reflection

- **Goal**: remove all duplicate provider-failure decisions on the current hot paths and prove the incident answer parks rather than ends.
- **Requirements**: R1–R8.
- **Approach**:
  1. Add the red failure matrix and renderer assertions.
  2. Add the red 402 proxy/park and harness held-turn fixtures.
  3. Implement the closed type, classifier, down-set predicate and renderer in `src/core/provider.ts`.
  4. Sanitize proxy errors into the typed wire envelope and persist the cause with provider level.
  5. Replace the pi harness prose lists with bridge classification plus cause decisions.
  6. Type in-process pi adapter failures; consume them in intake and reflection.
  7. Render an intake provider failure once in Slack; retain ordinary silent verdict behavior.
  8. Update exact spec proofs, record and plan.
- **Test scenarios**:
  - One matrix row per cause; the OpenRouter 402 with `limit_source` maps to `credit-or-quota-exhausted` and retains its URL only as operator metadata.
  - A 402 receives one retry, reports down with cause, persists the cause, parks the run and relays no payload or URL.
  - The pi harness holds a typed 402 turn and a recovered retry answers the original run.
  - Rate limit and transient causes park; key absent, key invalid, model unknown and permanent do not.
  - An intake provider failure yields one sentence, a typed receipt and one Slack reply; ordinary `silent` yields no reply.
  - An operator schema 400 yields the `request-rejected` sentence and one door record; no general run starts.
  - A reflection provider failure writes nothing and logs only the rendered sentence.
- **Verification**: focused Vitest files for every touched consumer and the state Worker provider-level fixture; scoped root and Worker TypeScript; prettier on changed files; `npm run hygiene:check`; `npm run specs:check`; CI runs full verification.

### U2. A provider probe resumes every parked turn and the plane says why once

- **Goal**: recovery no longer waits for an unrelated live call; one durable provider probe and card own the outage.
- **Requirements**: R9–R14.
- **Approach**:
  1. Add provider-scoped probe state and transition fixtures to the pure plane decider.
  2. Implement one bounded probe executor with a provider/model chosen from current configuration and no run turn.
  3. Schedule/recover probes from durable down rows; dedupe by provider and generation.
  4. On success, reuse the existing provider-up transaction and durable effect delivery.
  5. Add the OpenCode provider-down hold/release path beside pi's, preserving the cause through `session.execution.failed` and re-prompting the held execution once.
  6. Add the health-card projection with cause plus operator metadata; bind all user renderers to the safe renderer.
  7. Prove bot-roll recovery, repeated-down dedupe and one resume per parked run on both harnesses.
- **Test scenarios**:
  - Six parked runs under one credit failure create one down row, one card and one probe schedule.
  - Probe failures update the same row; no run finishes and no duplicate card appears.
  - Probe success writes up and reissues each parked turn once across push, heartbeat and reclaim.
  - A roll between probe success and effect delivery resumes without duplicate turns.
  - Thread/run/CLI renderers contain no payload or provider URL; operator health may carry the extracted URL.

### U3. Provider checks and health show key limit and remaining credit

- **Goal**: operators see account exhaustion coming from the same health surface that owns recovery.
- **Requirements**: R15–R19.
- **Approach**:
  1. Define the normalized account-credit row and injectable reader seam.
  2. Implement OpenRouter's `/api/v1/auth/key` mapping and error classification.
  3. Add daily-typical calculation from existing cost history with explicit empty-history output.
  4. Extend `providers check` and persist the snapshot for plane health.
  5. Render limit, usage, remaining and at most one threshold warning per key.
- **Test scenarios**:
  - Fixture `{limit, usage, limit_remaining}` prints exact normalized values in command and health panel.
  - Missing/null/unlimited values render by name without fabricated numbers.
  - Remaining below typical daily spend yields one warning; above yields none; no history names no threshold.
  - A failed account endpoint affects only its provider line and exposes no response body or key.

### U4. Deploy config refuses a configured provider with no key

- **Goal**: a production configuration cannot roll into guaranteed first-call failure.
- **Requirements**: R20–R24.
- **Approach**:
  1. Add effective provider-block reachability fixtures for defaults, intake and memory.
  2. Derive required variables, including Anthropic's default and excluding keyless local blocks.
  3. Feed the same derivation into deploy-config validation and secret-manifest generation.
  4. Remove static provider-key required/optional assumptions.
  5. Regenerate manifests and documentation through repository generators.
- **Test scenarios**:
  - A default, intake or memory model referencing a block with missing `apiKeyEnv` variable makes `deploy config` refuse and name it.
  - An unused block's missing key stays optional.
  - A keyless local block remains valid.
  - Changing a model ref moves the variable between required and optional manifest sets deterministically.
  - Refusal occurs before any deployment write and never prints a secret value.

## Verification Contract

| Criterion | Proof |
| --- | --- |
| The eight causes are closed and every fixture answer maps once | `src/core/providerConformance.test.ts::ProviderFailure — the closed failure matrix::*` |
| The incident 402 reports cause, parks and exposes no payload/URL | `src/channels/modelProxy.test.ts::the provider level and the park (record 0064)::a 402 credit limit is provider-down by typed cause…` |
| The harness holds and resumes a typed credit failure without a prose classifier | `src/core/harness/pi/harness.test.ts::runPiHarness — a run on pi from the first file to the answer::a typed 402 credit-limit failure holds the turn and resumes it instead of ending the run`; `::the harness's park decision is the typed cause set, not a second prose classifier` |
| Intake and operator carry and render one typed sentence instead of failing silent or falling through | `src/core/intake.test.ts::decideIntake — the verdict from one forced tool call (routing-and-config item 27)::a provider failure carries its typed cause and one safe sentence…`; `src/channels/slack.test.ts::receiveSlackMessage — the intake gate (docs/reference/specs/slack-channel.md item 15)::an intake provider failure is not silent…`; `src/core/dispatcher.test.ts::the operator behind routing.operator (record 0057; routing-and-config item 29)::on: an operator schema 400 renders one typed sentence and never falls through to general` |
| Memory reflection consumes the same seam | `src/core/memory/reflection.test.ts::reflect (one extractor call → store.write)::a provider failure is swallowed and reported through onWarn by typed cause, not provider prose` |
| The plane persists the provider-down cause | `deploy/cloudflare-memory/runLedger.test.ts::the plane's checkpoint steers and the provider condition — the heartbeat body, /plane/park, /plane/level provider (record 0064)::a provider down and parked live run recover atomically…` |
| One probe resumes every parked turn once | U2 plane/probe/effect race fixtures [gap: U2] |
| One operator card names the cause and user surfaces remain safe | U2 renderer-wide card/run/CLI fixtures [gap: U2] |
| Provider checks and health show limit and remaining with one warning | U3 account fixture and health projection tests [gap: U3] |
| Configured provider keys are required before deploy | U4 deploy-config and generated manifest tests [gap: U4] |
| Live operational receipt | On `worker:bot` at or beyond U2's merge SHA, a live 402 or 5xx parks the run; a successful probe resumes it; the plane names the cause once [gap: U2 deployment] |

Every implementation unit runs only changed-set fast gates before push: exact touched Vitest files; scoped TypeScript under `NODE_OPTIONS=--max-old-space-size=6144`; prettier on changed files; `npm run hygiene:check`; `npm run specs:check`; and `npm run check:pr-title -- "<title>"`. Generated checks run when their sources change. CI alone runs the full suite, full typecheck and `npm run verify`.

## Definition of Done

- U1–U4 merge in dependency order with exact living-spec proofs and no weakened guard.
- Every model-call failure reaches a consumer as one of eight causes.
- Provider-down causes park; one probe resumes every held turn once; provider account exhaustion never becomes a run failure.
- Every person-facing provider failure is one renderer sentence with no payload, provider URL or recovery instruction.
- `providers check` and plane health show provider-reported limit and remaining credit plus one evidence-based warning.
- `deploy config` refuses every missing key variable required by the effective provider configuration, while keyless and unused blocks remain valid.
- The operational 402/5xx receipt passes on the deployed bot Worker.
