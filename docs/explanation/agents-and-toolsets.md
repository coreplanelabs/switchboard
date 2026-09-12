# The agents and their toolsets

An agent is data (a system prompt, a named toolset, a machine class, an identity, budgets); every agent runs the same dispatcher loop, and the toolset, the machine and the identity distinguish them.

The loop: call the model, run the tool calls it asks for, append the results, repeat until it stops or a budget runs out. The [config layers](config-layers.md) choose the model, so any agent runs on any provider.

## The six agents

| Agent | What it does | Toolset | Machine | Identity | Budget |
|---|---|---|---|---|---|
| `general` | The default. Answers directly, reads repositories and manages issues, reads a URL; refers code, reviews and research onward. | `assistant`: GitHub reads and issue writes, URL fetch, status. No shell, no workspace. | `none` | `none` | 8 turns, 5 min |
| `coding` | Implements a change and pushes a branch; Switchboard renders its typed description and opens the PR. | `full`: bash, file read and write, URL fetch, diff digest, PR description, skills, GitHub reads, issue writes. | `repo-resident` | `write` | 60 turns, 45 min |
| `review` | Reviews a pull request with full-repository context; ranked findings and a verdict. | `readonly`: bash, file read, verdict, URL fetch, diff digest, skills, GitHub reads. | `repo-resident` | `read` | 30 turns, 25 min, effort `medium` |
| `ship` | Coding, review, fixes, until LGTM. A person merges. | Never sent to a model; each round runs `coding` or `review`. | `repo-resident` | `write` | The `ship` config block |
| `research` | Web search and URL reading, plus repository and issue reads; no workspace. | `web`: search, URL fetch, status, GitHub reads. | `none` | `none` | 12 turns, 8 min, effort `medium` |
| `explore` | A long, read-only investigation of a repository: clones it into a cold sandbox, runs builds, suites and pipelines, searches the web, and reports a claim table with commands and numbers. Never a pull request. | `explore`: bash, file read, status, URL fetch, search, skills, GitHub reads. | `repo-cold` | `read` | 150 turns, 120 min |

GitHub *read* tools need no workspace and are in every tool loop; issue *writes* are only in `assistant` and `full`. The identity is the credential a run's machine holds: `write` mints the write-scoped GitHub token that pushes and opens pull requests, `read` a read-scoped token with a read-only worktree, `none` nothing at all. The machine class is where the tools execute: `none` provisions nothing, and `repo-resident` is the onboarded repository's resident when it is serviceable, else a cold per-thread sandbox with the checkout. `repo-cold` is a per-thread sandbox with the checkout that never touches the resident (the repository is vetted against GitHub instead) — `explore` runs there, so a two-hour job shares no container with the reviews that depend on the resident. A fourth class, `blank`, an empty per-thread sandbox with no repository and no credential, exists for presets to come ([Execution and sandboxes](../reference/specs/execution.md)).

A command in a sandbox runs for at most twenty minutes; a job that needs longer is started detached with `setsid -f` and polled across tool calls — the explore prompt carries the recipe, and the sandbox's own timeout message names it.

## The toolset is the boundary, not the wall

A toolset decides what the model can ask for. `review` has no write-file tool but has `bash`, which writes files by other means. Read-only is a toolset-and-prompt contract; the wall is the executor ([Execution and trust](execution-and-trust.md)).

## The clock is the budget

The turn count is a backstop; the clock ends a long run, and at the deadline the agent is cut off to write up what it has. Effort rides the config layers because it decides how much of the clock goes to thinking; `review` ships with `medium`, `coding` leaves it to the request.

## Tools from outside

External MCP servers add tools as `mcp__<server>__<tool>`: descriptions and results are untrusted data, every call is budgeted and recorded, and only organization-level servers reach `coding`, `review` or `ship` ([Connect an MCP server](../how-to/connect-an-mcp-server.md)).

## Onboarded repositories

A coding or review run against an onboarded repository starts in its always-warm resident: a worktree on the thread's branch with dependencies installed. Other runs get a cold per-thread workspace on first use; follow-ups reuse it ([Onboard a repo](../how-to/onboard-a-repo.md)).

## Read next

- Specs: [general](../reference/specs/agent-general.md), [coding](../reference/specs/agent-coding.md), [review](../reference/specs/agent-review.md), [ship](../reference/specs/agent-ship.md), [research](../reference/specs/web-tools.md), [explore](../reference/specs/agent-explore.md), [GitHub tools](../reference/specs/github-tools.md).
- [Add an agent](../how-to/add-an-agent.md) — one registry entry ([decision 0002](../decisions/0002-dispatcher-is-the-only-orchestrator.md)).
- [How a request flows](how-a-request-flows.md) — the loop itself.
