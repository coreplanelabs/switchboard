# The agents and their toolsets

An agent is data (a system prompt, a named toolset, budgets); every agent runs the same dispatcher loop, and the toolset distinguishes them.

The loop: call the model, run the tool calls it asks for, append the results, repeat until it stops or a budget runs out. The [config layers](config-layers.md) choose the model, so any agent runs on any provider.

## The five agents

| Agent | What it does | Toolset | Budget |
|---|---|---|---|
| `general` | The default. Answers directly, reads repositories and manages issues, reads a URL; refers code, reviews and research onward. | `assistant`: GitHub reads and issue writes, URL fetch, status. No shell, no workspace. | 8 turns, 5 min |
| `coding` | Implements a change and pushes a branch; Switchboard renders its typed description and opens the PR. | `full`: bash, file read and write, URL fetch, diff digest, PR description, skills, GitHub reads, issue writes. | 60 turns, 45 min |
| `review` | Reviews a pull request with full-repository context; ranked findings and a verdict. | `readonly`: bash, file read, verdict, URL fetch, diff digest, skills, GitHub reads. | 30 turns, 25 min, effort `medium` |
| `ship` | Coding, review, fixes, until LGTM. A person merges. | Never sent to a model; each round runs `coding` or `review`. | The `ship` config block |
| `research` | Web search and URL reading, plus repository and issue reads; no workspace. | `web`: search, URL fetch, status, GitHub reads. | 12 turns, 8 min, effort `medium` |

GitHub *read* tools need no workspace and are in every tool loop; issue *writes* are only in `assistant` and `full`.

## The toolset is the boundary, not the wall

A toolset decides what the model can ask for. `review` has no write-file tool but has `bash`, which writes files by other means. Read-only is a toolset-and-prompt contract; the wall is the executor ([Execution and trust](execution-and-trust.md)).

## The clock is the budget

The turn count is a backstop; the clock ends a long run, and at the deadline the agent is cut off to write up what it has. Effort rides the config layers because it decides how much of the clock goes to thinking; `review` ships with `medium`, `coding` leaves it to the request.

## Tools from outside

External MCP servers add tools as `mcp__<server>__<tool>`: descriptions and results are untrusted data, every call is budgeted and recorded, and only organization-level servers reach `coding`, `review` or `ship` ([Connect an MCP server](../how-to/connect-an-mcp-server.md)).

## Onboarded repositories

A coding or review run against an onboarded repository starts in its always-warm resident: a worktree on the thread's branch with dependencies installed. Other runs get a cold per-thread workspace on first use; follow-ups reuse it ([Onboard a repo](../how-to/onboard-a-repo.md)).

## Read next

- Specs: [general](../reference/specs/agent-general.md), [coding](../reference/specs/agent-coding.md), [review](../reference/specs/agent-review.md), [ship](../reference/specs/agent-ship.md), [research](../reference/specs/web-tools.md), [GitHub tools](../reference/specs/github-tools.md).
- [Add an agent](../how-to/add-an-agent.md) — one registry entry ([decision 0002](../decisions/0002-dispatcher-is-the-only-orchestrator.md)).
- [How a request flows](how-a-request-flows.md) — the loop itself.
