# Add an agent

Add a specialist agent — a prompt, a toolset and budgets — that is reachable as `agent:<name>` on every surface, with the same config layering, authorization and run tracking as the built-in ones.

## Before you start

- A checkout of the repository and the [contributing](../../CONTRIBUTING.md) loop. An agent is data in the tree, so this is a pull request, not a config change.
- A decision on what the agent may touch: one of the named toolsets (`full`, `readonly`, `web`, `assistant`, `none`) and its turn, token and wall-clock budgets.

## 1. Define it

Add an entry to `AGENTS` in `src/agents/registry.ts`:

```ts
docs: {
  name: "docs",
  description: "Answers questions about a repository's documentation; read-only.",
  system: DOCS_SYSTEM,        // the prompt
  toolset: "readonly",
  maxTurns: 20,               // a backstop; the wall clock is the real budget
  maxTokens: 24000,
  maxMinutes: 10,
  resources: { repo: "required" }, // a workspace is provisioned; omit for an agent that needs none
},
```

Every field is documented on `AgentDef` in the same file. The toolset names decide what the model may ask for; [The agents and their toolsets](../explanation/agents-and-toolsets.md) lists what each contains. `resources` says whether a run needs a repository checkout at all; an agent without it never provisions a workspace or sandbox. `effort` is optional: the agent's built-in effort, which every config layer beats.

## 2. Give it a default model

```yaml
defaults:
  models:
    docs: anthropic/claude-haiku-4-5
```

Without an entry, the agent falls back to `defaults.models.general`.

## 3. Write its contract

Each built-in agent has a spec under `docs/reference/specs/` (`agent-general.md`, `agent-review.md`, …) whose criteria are bound to tests. Add one for yours; `npm run specs:check` requires every proof to resolve.

## 4. Decide who may run it

A new agent is open to everyone unless it is listed under `restrict.agents` ([Restrict who can do what](restrict-who-can-do-what.md)).

## 5. Try it

```bash
npm run cli -- ask "agent:docs where is the deploy order specified?"
```

`help` lists the agent from the registry; there is no separate registration for Slack, the CLI, HTTP or MCP.

## What you did

You added an agent as data behind the agent seam; the dispatcher never learned its name. Why an agent is data and the dispatcher the only orchestrator: [the decision record](../decisions/0002-dispatcher-is-the-only-orchestrator.md).

## See also

- [Add a model provider](add-a-provider.md) — the other seam you extend without touching the dispatcher.
- [How a request flows](../explanation/how-a-request-flows.md).
