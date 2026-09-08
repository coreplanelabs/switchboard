# The agents and their toolsets

An agent in Switchboard is data, not code: a system prompt, a named toolset, and budgets (turns, tokens, wall-clock minutes). The dispatcher runs every agent through the same loop — call the model, execute the tool calls it asks for, append the results, repeat until the model stops or a budget runs out — so what distinguishes the agents is what each is *allowed to reach*, and that is the toolset. Which model an agent runs on is decided separately, by the [config layers](config-layers.md), so any agent can run on any configured provider.

## The five agents

| Agent | What it does | Toolset | Turn budget |
|---|---|---|---|
| `general` | The default — a plain mention. Answers directly, reads the organization's repositories and manages their issues over GitHub, reads a linked URL. Refers code changes, PR reviews and web research to the other agents rather than attempting them ([spec](../reference/specs/agent-general.md)). | `assistant` — GitHub reads and issue writes, URL fetch, status updates. No shell, no workspace. | 8 turns, 5 minutes |
| `coding` | Implements a change and ships a pull request ([spec](../reference/specs/agent-coding.md)). Cold path: clone, branch, edit, test, push. Resident path: the worktree is already warm. Either way the agent pushes the branch and submits a typed description; Switchboard renders the body at the pushed head and opens the PR itself ([spec](../reference/specs/pr-description.md)). | `full` — bash, read and write files, URL fetch, diff digest, PR description, skills, GitHub reads and issue writes. | 60 turns, 45 minutes |
| `review` | Reviews a pull request with full-repository context and posts ranked findings with a submitted verdict ([spec](../reference/specs/agent-review.md)). | `readonly` — bash, read files, verdict, URL fetch, diff digest, skills, GitHub reads. No file writes, no issue writes. | 30 turns, 25 minutes; effort `medium` built in |
| `ship` | Runs coding, then review, then fixes, as one pipeline until the review says LGTM ([spec](../reference/specs/agent-ship.md)). Opens the PR, loops review and fix rounds, reports merge-ready. A person still merges. | Orchestrator only: its definition is never sent to a model. Each child round runs on the `coding` or `review` definition above. | Bounded by the `ship` config block (rounds and minutes), not by its own numbers |
| `research` | Answers questions with web search and URL reading, plus read access to the organization's repositories and issues. Never provisions a repository or workspace ([spec](../reference/specs/web-tools.md)). | `web` — web search, URL fetch, status updates, GitHub reads. | 12 turns, 8 minutes; effort `medium` built in |

The GitHub *read* tools (repositories, trees, files, code search, issue list and get) are in every toolset that has a tool loop, because they need no workspace and let any agent answer from the code. The issue *write* tools go only where the agent may act on GitHub: `assistant` and `full`. The review and research agents never mutate GitHub ([spec](../reference/specs/github-tools.md)).

## Why the toolset is the boundary, and where it is not

A toolset decides what the model can *ask for*. The review agent has no write-file tool, so it cannot ask to write a file. But `bash` is in its toolset, and a shell can write files by other means — "read-only" is a contract enforced by toolset and prompt, not a wall. The wall is the executor: where those commands run, and what that place can reach. That is why [Execution and trust](execution-and-trust.md) is a separate page, and why the coding agent's power to push code is a property of the sandbox or resident it runs in, never of the bot process.

## Turn budgets are backstops; the clock is the budget

Every agent carries a turn budget and a wall-clock budget. The turn count is a backstop. The clock is what actually ends a long run: at the deadline the agent is cut off and made to write up what it has so far. Effort — how hard the model thinks per turn — rides the same config layers as the model, because it decides how much of that clock goes to thinking rather than to work. The review agent ships with `medium` built in; the coding agent has no built-in effort, so the deployment or the request decides.

## Tools an agent can be given from outside

Any agent can additionally be handed tools from external MCP servers: they appear as `mcp__<server>__<tool>`, their descriptions and results are treated as untrusted data, and every call is budgeted and recorded. Which servers reach which agents is a config decision in three tiers, and only organization-level servers may reach `coding`, `review` or `ship`. How to connect one: [Connect an MCP server](../how-to/connect-an-mcp-server.md).

## Where an onboarded repository fits

A coding or review run against a repository an admin has onboarded starts in that repository's always-warm resident environment — a ready worktree on the thread's branch, dependencies installed. Every other run gets a cold per-thread workspace, cloned on first use. On both paths, follow-ups in the same thread reuse the same checkout. [Onboard a repo](../how-to/onboard-a-repo.md) is the how-to; [Worker topology](worker-topology.md) is what a resident is underneath.

## See also

- [Add an agent](../how-to/add-an-agent.md) — a new agent is one registry entry; why an agent is data and the dispatcher the only orchestrator is [decision 0002](../decisions/0002-dispatcher-is-the-only-orchestrator.md).
- [How a request flows](how-a-request-flows.md) — the loop every agent runs through.
- [Reference: Slack commands](../reference/slack-commands.md) — the `agent:` directive and the rest of the grammar.
