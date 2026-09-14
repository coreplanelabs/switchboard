---
title: The title gate in the child contract - Plan
type: feat
date: 2026-09-14
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
extends: ../decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md
---

# The title gate in the child contract - Plan

## Goal Capsule

- **Objective**: A coding child proves its pull request title the way it proves its tests. The child contract names the title gate among the guards a child runs, and the coding preset's prompt names the same gate from the same constant, so the two never drift. Two small units; the second imports what the first adds.
- **Why**: the plan runner's first unit pull request sat red on exactly one check, the title gate, because the child chose a scope the code map did not name and nothing it was handed said how a title is judged. The rule lives in the repository's agent guidance, but a child works from its contract, and the contract did not carry it.
- **Authority**: record 0031 (a child is handed a contract, never a task string); [agent-ship.md](../reference/specs/agent-ship.md) item 13 (the contract is a typed object the pipeline renders); [agent-coding.md](../reference/specs/agent-coding.md) (the coding run's proofs and post-step).
- **Stop conditions**: a unit that cannot pass `npm run verify` within its listed files hands back a deviation; nothing here changes a Worker, a deploy or a credential.

---

## Implementation Units

### U1. The child contract names the title gate

- **Goal**: The rendered child contract lists `check:pr-title` among the guards a child may not weaken, with one line on what it refuses: a title whose type, scope or grammar is not the changelog line, the scope being one of the code map's Areas.
- **Dependencies**: none.
- **Files**: `src/core/ship/contract.ts` (`GUARDS` gains the entry; export its name as a constant the prompt can import); `src/core/ship/contract.test.ts`.
- **Approach**:
  1. Tests first: the rendered contract for a fixture unit names `check:pr-title` in its Guards section and states the scope rule; red against the current list.
  2. Add the guard beside `specs:check`, `specs:coverage --test-guard`, `hygiene:check` and `decisions:check`, in the same one-line-on-what-it-refuses voice, and export the guard's name (a named constant) so another module can name the same gate without a copied string.
- **Patterns to follow**: the existing `GUARDS` entries and `renderGuards` in `src/core/ship/contract.ts`; the render tests in `src/core/ship/contract.test.ts`.
- **Test scenarios**:
  - `src/core/ship/contract.test.ts`: the Guards section of a rendered contract names `check:pr-title` and its refusal line; the guard list is rendered in full even when the render is cut to its budget (guards are never truncated).
- **Verification**: `npx vitest run src/core/ship/contract.test.ts` green, red first; `npm run specs:check`; `npm run verify` green.

### U2. The coding prompt names the same gate

- **Goal**: The coding preset's system prompt tells a coding run to judge its title with the title gate before it submits its description, naming the gate through the constant the contract exports, so the prompt and the contract cannot say two different things.
- **Dependencies**: U1 (the constant it imports).
- **Files**: `src/agents/registry.ts` (the coding preset's PR-description guidance: one sentence naming the gate and the command, `npm run check:pr-title -- "<title>"`); `src/agents/registry.test.ts`.
- **Approach**:
  1. Tests first: the coding preset's system prompt names the title gate and the command; the same text is absent from presets that open no pull request (review, research, explore, general); red before the change.
  2. Import the guard's name from `src/core/ship/contract.ts` (the module is already imported there for the contract headings) and place one sentence in the PR-description guidance, next to where the prompt says the description is submitted with the tool.
- **Patterns to follow**: how `src/agents/registry.ts` already imports `CONTRACT_SECTION_HEADINGS` from the contract module so one spelling serves both; the prompt tests in `src/agents/registry.test.ts`.
- **Test scenarios**:
  - `src/agents/registry.test.ts`: the coding prompt contains the gate's name and the command; the review, research, explore and general prompts do not.
- **Verification**: `npx vitest run src/agents/registry.test.ts` green, red first; `npm run verify` green.

---

## Definition of Done

- Both units merged on `main` through the ordinary review gate; a rendered contract and the coding prompt name the same title gate from one constant.
- The runner's record for this plan shows two units, the second started only after the first merged.
