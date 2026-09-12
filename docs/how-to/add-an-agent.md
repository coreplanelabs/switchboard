# Add an agent

Add a specialist agent (a prompt, a toolset and budgets) reachable as `agent:<name>` on every surface, with the same config layering, authorization and run tracking as the built-in ones.

**You need:**

- A checkout of the repository and the [contributing](../../CONTRIBUTING.md) loop. An agent is data in the tree, so this is a pull request, not a config change.
- A toolset for it (`full`, `readonly`, `web`, `assistant`, `explore`, `none`), the machine class its tools run on, the identity its runs act as, and its turn, token and wall-clock budgets.

## Define it

Add an entry to `AGENTS` in `src/agents/registry.ts`:

```ts
docs: {
  name: "docs",
  description: "Answers questions about a repository's documentation; read-only.",
  system: DOCS_SYSTEM,        // the prompt
  toolset: "readonly",
  machine: "repo-resident",   // the repository's resident, else a cold sandbox; "none" for an agent without a workspace
  identity: "read",           // the credential its sandbox holds: a read-scoped token and a read-only worktree
  maxTurns: 20,               // a backstop; the wall clock is the real budget
  maxTokens: 24000,
  maxMinutes: 10,
},
```

Every field is documented on `AgentDef` in the same file.

| Field | What it decides |
|---|---|
| `toolset` | what the model may ask for ([The agents and their toolsets](../explanation/agents-and-toolsets.md) lists each) |
| `machine` | where a run's tools execute: `repo-resident` provisions the target repository's resident when it is serviceable, else a cold sandbox with the checkout; `repo-cold` always the cold sandbox with the checkout, the repository vetted against GitHub and the resident never consulted; `blank` an empty sandbox with no repository and no credential; `none` provisions nothing |
| `identity` | whom a run acts as: `write` mints the write-scoped GitHub token a run needs to push and open pull requests; `read` a read-scoped token and a read-only worktree; `none` no credential at all (a `none` machine, or a checkout cloned anonymously) |
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
