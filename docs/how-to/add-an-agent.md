# Add an agent

Add an agent when a recurring kind of work needs a distinct work profile: instructions, tools, execution machine, identity or budget. [What an agent is](../explanation/agents-and-toolsets.md) explains how a definition differs from a run.

An agent is code-reviewed data in `src/agents/defaults.json`; an installation extends its settings through the same DSL. It becomes available on the supported channels through the existing dispatcher.

## Define the work

1. Add the name to `LOOP_PRESETS` and its default limits to `src/agents/defaults.json` (the `ASKS` table derives from it), `PRESET_FLOORS` and `POST_STEP_MINUTES` in [`src/core/budgets.ts`](../../src/core/budgets.ts). These tables are typed against the preset list.
2. Add its data entry to `agents` in [`src/agents/defaults.json`](../../src/agents/defaults.json). Set `instructions: builtin:<name>`, `tools`, `machine`, `identity`, model choices and limits. Add its builtin prompt to [`src/agents/registry.ts`](../../src/agents/registry.ts); the registry derives the metadata and turn guard from the data document.
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

The agent selects `agentDefaults.profile` unless its own `profile` overrides it. Profiles and agent entries can set `model` and `modelSettings.reasoning.effort`; refs use `<provider>/<model>`. Register the new name in the shipped document so the config validator can accept installation extensions. Decide whether `restrict.agents` should limit who can invoke the new name.

## Verify

Run `npm run fix`, then the changed test files by name with `npx vitest run <file>`. Check `npm run specs:check` and the changed documentation. For local work, run `npm run verify` before requesting review. The [contributing guide](../../CONTRIBUTING.md) explains the complete change and review loop.
