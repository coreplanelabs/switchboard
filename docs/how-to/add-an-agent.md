# Add an agent

Add an agent when a recurring kind of work needs a distinct work profile: instructions, tools, execution machine, identity or budget. [What an agent is](../explanation/agents-and-toolsets.md) explains how a definition differs from a run.

An agent is code-reviewed data in the repository, not a runtime config entry. It becomes available on the supported channels through the existing dispatcher.

## Define the work

1. Add the name to `LOOP_PRESETS` and its defaults to `ASKS`, `PRESET_FLOORS` and `POST_STEP_MINUTES` in [`src/core/budgets.ts`](../../src/core/budgets.ts). These tables are typed against the preset list.
2. Add the definition to `AGENTS` in [`src/agents/registry.ts`](../../src/agents/registry.ts). Set its prompt, `toolset`, `machine`, `identity`, allowed model choices, `maxTokens` and budget. For a model-loop agent, derive its turn guard with `runawayTurnCap(ASKS.<name>)`; the wall clock is the actual budget.
3. Choose its entry path. A normal definition can be routed from a plain request. Set `routable: false` for an agent that requires `agent:<name>`. The compound route is reserved for `conductor`.
4. Reuse a toolset from [`src/tools/toolsets.ts`](../../src/tools/toolsets.ts), or add one when the tools truly differ. Workspace tools also depend on the run's identity and machine; a toolset name alone does not grant host or repository access.

| Choice | Meaning |
| --- | --- |
| `machine: none` | No workspace; bot-side tools only |
| `machine: repo-resident` | Onboarded repository workspace when available, with sandbox fallback |
| `machine: repo-cold` | Cold per-thread repository sandbox |
| `machine: blank` | Empty per-thread sandbox |
| `identity: none / read / write` | No minted repository credential, read-scoped credential, or write-scoped credential |

The requester's permissions and configured boundaries still apply to every run. If only the model or effort changes, use [configuration](configure-your-defaults.md) instead of adding an agent.

## Give it a contract and a model default

Add a behavioral spec under [`docs/reference/specs/`](../reference/specs/README.md), with proof for its distinct behavior. Add or update focused tests for routing, authorization, budget and tool reach as needed.

A configured `defaults.models.<name>` chooses its usual model; without one, the agent falls back to `defaults.models.general`. Model refs use `<provider>/<model>` and remain separate from the agent definition. Decide whether `restrict.agents` should limit who can invoke the new name.

## Verify

Run `npm run fix`, then the changed test files by name with `npx vitest run <file>`. Check `npm run specs:check` and the changed documentation. For local work, run `npm run verify` before requesting review. The [contributing guide](../../CONTRIBUTING.md) explains the complete change and review loop.
