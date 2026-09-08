# Add an agent

Add a specialist agent (a prompt, a toolset and budgets) reachable as `agent:<name>` on every surface, with the same config layering, authorization and run tracking as the built-in ones.

**You need:**

- A checkout of the repository and the [contributing](../../CONTRIBUTING.md) loop. An agent is data in the tree, so this is a pull request, not a config change.
- A toolset for it (`full`, `readonly`, `web`, `assistant`, `none`) and its turn, token and wall-clock budgets.

## Define it

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

Every field is documented on `AgentDef` in the same file.

| Field | What it decides |
|---|---|
| `toolset` | what the model may ask for ([The agents and their toolsets](../explanation/agents-and-toolsets.md) lists each) |
| `resources` | whether a run needs a repository checkout; without it no workspace or sandbox is provisioned |
| `effort` (optional) | the agent's built-in effort, which every config layer beats |

## Give it a default model

```yaml
defaults:
  models:
    docs: anthropic/claude-haiku-4-5
```

Without an entry, the agent falls back to `defaults.models.general`.

## Write its contract

Add a spec under `docs/reference/specs/` beside `agent-general.md` and `agent-review.md`, each criterion bound to a test. `npm run specs:check` requires every proof to resolve.

## Decide who may run it

A new agent is open to everyone unless it is listed under `restrict.agents` ([Restrict who can do what](restrict-who-can-do-what.md)).

## Try it

```bash
npm run cli -- ask "agent:docs where is the deploy order specified?"
```

`help` lists the agent from the registry; there is no separate registration for Slack, the CLI, HTTP or MCP.

## Next

- [The dispatcher is the only orchestrator](../decisions/0002-dispatcher-is-the-only-orchestrator.md): why an agent is data.
- [Add a model provider](add-a-provider.md): the other seam you extend without touching the dispatcher.
- [How a request flows](../explanation/how-a-request-flows.md).
