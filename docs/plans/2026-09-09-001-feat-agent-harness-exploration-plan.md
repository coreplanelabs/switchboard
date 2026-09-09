---
title: Agent harness exploration (pi, OpenRouter) - Plan
type: feat
date: 2026-09-09
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: draft
product_contract_source: session 2026-09-09 (Justin + Claude) — "explore and plan, don't do it yet"
execution: research
---

# Agent harness exploration (pi, OpenRouter) - Plan

## Goal Capsule

- **Objective**: Decide, with measurements rather than opinion, whether Switchboard's long-running and multi-agent runs should execute on an open-source agent harness instead of the in-house turn loop, and whether model routing should go through an aggregator so an installation is provider-agnostic by configuration alone. Candidates named by the product owner: [pi](https://pi.dev) (the minimal agent harness from Earendil, MIT) and [OpenRouter](https://openrouter.ai).
- **Product contract**: "Right now we just call the LLM provider directly. For long-running multi-agent work we should look for opportunities to use open-source stuff like pi.dev and OpenRouter. This also makes it agnostic." This plan explores and stages; it adopts nothing. Adoption is a later decision record with the spike's numbers attached.
- **Authority**: the decision records under `docs/decisions/` hold. In particular `dispatch()` stays the only place a run starts (0002), every tool call passes the one policy table (0007), every model output the surfaces depend on is a typed contract (0010), a run has two lives and a durable ledger (0006, 0019), and a span is the one measurement (0020). A harness that cannot sit inside those is not a candidate.
- **Sequencing**: nothing in this plan starts — not even Phase 0 — until the open-source flip (`2026-09-04-001-feat-oss-readiness-plan.md`) has shipped and the public repository is working. The product owner's instruction is explicit: explore and plan now, build afterwards. It is tracked on the same board because the argument is the same one — an installation brings its own provider and its own harness, nothing is baked in (D13, installed not forked).
- **Stop conditions**: any design that requires a model API key inside the sandbox or resident plane without a per-run credential in front of it (the security model puts model credentials in the bot plane only); any design where the run record depends on the harness's own session file to be complete; any design that hides which tools a run may call from the authorization table.

---

## Where we are today

| Fact | Where |
|---|---|
| Two provider adapters behind one seam: Anthropic (native, effort tiers `low`…`max`, document inputs) and a generic OpenAI-compatible Chat Completions adapter that needs only a `baseUrl` | `src/providers/anthropic.ts`, `src/providers/openaiCompat.ts`, `src/providers/registry.ts`, `src/providers/types.ts` |
| The example config already routes through the compatible adapter to OpenAI, Groq and Ollama by URL | `config/config.example.yaml` (the `providers:` block) |
| The turn loop — model call, typed tool dispatch, budgets, status, the run stream — is in-house, in the dispatcher, with the tools defined once and derived onto every surface | `src/core/dispatcher.ts`, `src/tools/`, decision 0008 |
| Tools run inside an executor (local, E2B, Cloudflare sandbox, resident); the model credential never leaves the bot | `src/execution/`, `docs/explanation/security-model.md`, decision 0009 |
| Provider A/B harness exists: same tasks against the real API, cost and outcome recorded | the load and A/B tooling under `src/load/` |

## What the candidates are

**OpenRouter** is an OpenAI-compatible endpoint (`https://openrouter.ai/api/v1`, bearer auth, `provider/model` ids) that routes one request to hundreds of models with automatic fallbacks and cost-based routing; tool calling and streaming are supported. It fits the existing compatible adapter with **zero code**: a `providers:` entry with that `baseUrl`. What it does not give the compatible path is what the native Anthropic adapter has today: the extended effort tiers, document inputs, provider-specific caching. Those gaps are the adapter's, not OpenRouter's, and are measurable.

**pi** is a coding agent and harness published as a monorepo of MIT packages: `@earendil-works/pi-coding-agent` (the CLI and SDK), `@earendil-works/pi-agent-core` (the runtime: tool calling and state), `@earendil-works/pi-ai` (one API over fifteen-plus providers including OpenRouter and Ollama), `@earendil-works/pi-telemetry`. Three properties matter here:

1. **It embeds.** `--mode rpc` speaks LF-delimited JSONL over stdin/stdout; `--mode json` streams every event; the SDK exposes `createAgentSession`, `ModelRuntime`, `SessionManager` (in-memory or on-disk sessions as branching JSONL trees, resumable with `--session` / `--fork`).
2. **Tools are extensions.** A TypeScript module exports a function receiving `ExtensionAPI`: `pi.registerTool(...)`, `pi.on("tool_call", ...)`. Our GitHub, Slack and verdict tools, and our policy gate, can be an extension package; sub-agents and plan mode are themselves extensions.
3. **It reads AGENTS.md** and ships skills and prompt templates — the same contract shape this repository already publishes for its own agents.

## Three ways it could fit, and which one to test

| Option | What changes | What it buys | What it risks |
|---|---|---|---|
| **A. `pi-ai` as the provider layer** | `src/providers/` becomes an adapter over pi-ai's unified API; the loop stays ours | fifteen providers, maintained by someone else | a dependency on the shape of one library's message model in the core; the native Anthropic features must be re-verified through it |
| **B. `pi-agent-core` as the loop** | the dispatcher hands the turn loop to pi's runtime, our tools registered into it | a maintained loop, sessions, sub-agents | the loop is where budgets, status, tracing and the run stream live today; a swap touches every invariant at once |
| **C. pi as a subprocess in the executor** (the "harness") | for `coding` and `ship` runs the executor starts `pi --mode rpc` inside the resident or sandbox; our tools and the verdict become a pi extension; pi's events feed the run stream and the tracer; the model credential reaches pi through a per-run proxy the bot exposes | long-running, multi-step, multi-agent coding runs on a harness built for exactly that; the bot's own loop keeps `general`, `review`, `research` unchanged | two prompt vocabularies; pi baked into the sandbox-base and resident images; the credential proxy is new surface; cost attribution must come from pi's usage events |

**Recommendation: test C first, adopt OpenRouter as a documented example now.** C is the only option that answers the product question (long-running multi-agent work) without rewriting the parts of Switchboard that are the product — channels, authorization, run records, tracing, the typed verdict. A and B are refactors of working code and can wait for C's result.

## Phases

### Phase 0 — OpenRouter as a documented example (config only)

- A commented `providers:` example for OpenRouter in `config/config.example.yaml` and one paragraph in `docs/how-to/configure-your-defaults.md` (which key, which `baseUrl`, the `provider/model` id form, what the compatible adapter does not do).
- One A/B run of the existing harness: the same five tasks on the native Anthropic adapter and on the same model through OpenRouter's compatible endpoint; cost, wall time, outcome. Numbers go on the tracking issue.

**Done when**: an operator with only an OpenRouter key can run `ask` by editing config alone, and the A/B numbers are on the tracker.

### Phase 1 — The spike: pi inside a resident, five coding tasks

- Install pi in one resident thread by hand (no image change yet); start it with `--mode rpc`; drive it from a scratch script that speaks the JSONL protocol; give it a minimal extension exposing `submit_verdict` and a `tool_call` hook that logs every tool the model asked for.
- Run the five representative coding tasks the A/B harness already uses; run the same five on today's `coding` agent.
- Measure per task: wall time, model cost (from pi's usage events vs the bot's), tool calls, whether the PR-shaped outcome was reached, and how many of pi's tool calls our policy table would have refused.
- Prototype the events bridge on paper: which pi events map to `run_event` kinds and to spans; what has no home.

**Done when**: a table of ten runs (five each side) with cost, time and outcome is on the tracker, plus the list of pi events that do not map and the list of tool calls the policy would have refused.

### Phase 2 — The decision record

- A record under `docs/decisions/` deciding one of: adopt C for `coding`/`ship` behind a per-agent `harness: native | pi` strategy; adopt nothing and close; or adopt A only. Context is the spike's table; consequences name the invariants touched (0002, 0006, 0007, 0010, 0019, 0020) and how each holds.
- The record is the gate for any code. Justin's call.

### Phase 3 — If adopted: the seam

- `harness` as a Strategy per agent definition (`native` today, `pi`); the executor starts pi with the run's cwd and the extension package.
- `@switchboard/pi-tools`: an extension registering the GitHub and Slack tools and `submit_verdict`, and a `tool_call` hook that consults the run's grant set — the authorization table stays the one place.
- A per-run model-credential proxy in the bot: pi is configured with an OpenAI-compatible `baseUrl` pointing at the bot and a run-scoped bearer; the bot forwards to the configured provider and records usage. The sandbox and resident planes never hold a provider key.
- Events bridge: pi JSONL events → run events and spans; the run record is complete without pi's session file.
- Images: pi pinned in the sandbox-base and resident Dockerfiles, checked by the existing image build.

### Phase 4 — If adopted: multi-agent

- pi's sub-agent extension for `ship` (plan → implement → self-review fan-out) under the parent run's budget, with each child as a child span.

## Open questions

- pi's release cadence and the stability of the RPC protocol and `ExtensionAPI` across versions; pin and check like every other image dependency.
- Node version the pi packages require versus the sandbox-base and resident images.
- How pi's built-in tools (edit, bash, read) interact with the resident's per-thread OS users and the mirror lock — they run as the thread's user like today's `bash` tool, but pi's bash is not our `bash` tool: budgets and output caps must be re-imposed by the hook or the executor.
- Whether the credential proxy should be OpenAI-compatible only (pi accepts any compatible `baseUrl`) or also speak the Anthropic API so the native tiers survive.
- Cost attribution: the costs page today reads provider usage from the bot; with pi the source of truth is pi's usage events or the proxy's ledger — the proxy makes it the bot's again.

## Validation

Every phase's receipt is a table on the tracking issue. Phase 1's table is the only input Phase 2 may cite. Nothing in this plan changes behavior until Phase 3, which ships behind the per-agent strategy with `native` as the default and is covered by the specs it touches (`agent-coding.md`, `agent-ship.md`, `execution.md`, `costs.md`) in the same PRs.
