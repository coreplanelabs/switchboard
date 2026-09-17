---
title: The OpenAI block says what the compatible adapter carries for it - Plan
type: docs
date: 2026-09-17
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: docs
extends: ../how-to/add-a-provider.md
---

# The OpenAI block says what the compatible adapter carries for it - Plan

## Goal Capsule

- **Objective**: The example configuration already ships an `openai:` block on the compatible adapter, and the provider how-to already says any Chat Completions endpoint is a block with no code behind it — but neither says what an operator gives up by running OpenAI's models through the compatible shape: no control over reasoning from our effort tiers, Chat Completions rather than the Responses API, tokens metered but not priced. The OpenRouter block beside it says exactly this for its own case. One documentation unit closes the gap in the same two places, so the first operator to set `openai/<model>` as a default reads the trade before the run does.
- **Authority**: [add-a-provider](../how-to/add-a-provider.md) and [configure-your-defaults](../how-to/configure-your-defaults.md) as written; the example configuration's own convention that a block's comment names what the adapter does not carry (the OpenRouter block); [harness-pi](../reference/specs/harness-pi.md) item 13 for what the compatible adapter sends on the wire.
- **Execution profile**: one unit under the plan runner with the runner's merge grant. The unit's Verification names the project's full check on purpose: this unit is also the live procedure for [agent-coding](../reference/specs/agent-coding.md) item 13, and its card must show the push before that check runs.
- **Stop conditions**: documentation and one comment in the example configuration only; no block added, removed or uncommented, no key, no code. A unit that would touch anything outside the two files hands back a deviation.

## Implementation Units

### U1. The comment and the how-to line

- **Goal**: The `openai:` block in `config/config.example.yaml` carries a comment, in the OpenRouter block's register, saying what the compatible adapter carries for OpenAI's models and what it does not; `docs/how-to/add-a-provider.md` names OpenAI as the same shape with one sentence pointing at that trade.
- **Files**: `config/config.example.yaml` (comment lines above the existing `openai:` block only; the block's three keys stay exactly as they are — the example-config test loads them); `docs/how-to/add-a-provider.md` (one sentence in the "Add the block" section). Nothing else.
- **Approach**:
  1. Read the OpenRouter block's comment for the register and the test in `src/config.test.ts` (`the example config's provider blocks`) for what the example must keep loading.
  2. Above `openai:`, replace the one-line comment with a short block comment: OpenAI's models run on the same Chat Completions adapter, so `openai/<model-id>` works anywhere a model is accepted; the adapter sends no reasoning control (our effort tiers do not reach these models), speaks Chat Completions rather than the Responses API, and meters tokens without pricing them; a first-class block is the plan's business, not this file's.
  3. In `add-a-provider.md`, after the Groq example, one sentence: OpenAI itself is the same shape, as the example configuration's `openai:` block shows, with the same limits the block's comment names.
  4. Prove with the cheapest checks that fit — the example-config test file and `npm run docs:check` — then commit and push; the full `npm run verify` runs after the push.
- **Verification**: `src/config.test.ts` green (the example still loads with its blocks), `npm run docs:check`, `npm run verify` (after the push, per the coding prompt's order of checks).

## Definition of Done

- The two files carry the comment and the sentence; no other file changed; the example still loads.
- The unit's pull request was merged by the plan runner, and its card showed the push before the full check ran (the live row of agent-coding item 13, recorded in the tracker).
