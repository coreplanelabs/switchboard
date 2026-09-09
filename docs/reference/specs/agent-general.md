# Agent: general

The default — the plain @-mention. A fast model with a small, workspace-free toolset: it answers directly, reads the org's repositories and acts on their issues through OpenSwitchboard's GitHub credential, and reads a linked URL — so the everyday asks are answered here, and only code changes, PR reviews, and web research are handed to the other agents.

- **Code**: `src/agents/registry.ts` (`general`, `GENERAL_SYSTEM`), `src/tools/workspace.ts` (the `assistant` toolset), `src/tools/github.ts`, default model in the deployed config (`config/config.example.yaml` documents the key)
- **Docs**: [The agents and their toolsets](../../explanation/agents-and-toolsets.md), [github-tools.md](github-tools.md)
- **Budgets**: 8 turns / 5 min / 16k tokens · toolset `assistant`

## Behavior

1. Answers directly and concisely in Slack-friendly formatting. Its tools are the `assistant` toolset ([github-tools.md](github-tools.md) items 4–5): the GitHub reads (`github_repos`, `github_tree`, `github_file`, `github_search_code`, `github_issue_list`, `github_issue_get`), the issue writes (`github_issue_create` / `update` / `comment` / `delete`), `web_fetch`, and `update_status` — no shell, no file writes, no `web_search`, no verdict or PR submission.
2. Runs on a fast/cheap model by default (production: haiku) — the speed *is* the feature; 8 turns is room for repos → tree → file or an issue action, not for exploration.
3. Never claims abilities it lacks and never fabricates: when a request needs a code change, a PR review, or web research it redirects to `agent:coding` / `agent:review` / `agent:research` explicitly (the system prompt names them with examples). When it acts, it reports exactly what the tool did (issue number + URL) and never claims an action it did not perform. A loosely-named repo ("the switchboard app") is resolved with `github_repos` or the thread, not by asking. Deleting an issue happens only on an explicit delete request — closing is an update; and since GitHub grants deletion only to a repo admin's user credential, the App-backed delete reports its refusal and offers to close instead ([github-tools.md](github-tools.md) item 1). Regression pins: inventing a repo URL and telling the user to run git; bouncing "open an issue on the switchboard app" to `agent:coding` with "I have no tools for that".
4. **Declares no resources** (`AgentDef.resources` omits `repo`): a general ask never creates, reconnects, or touches a sandbox or workspace — even when remote execution (E2B/Cloudflare) is configured, and even when the sandbox credential is missing. The GitHub tools are REST calls in the bot process, not a workspace. See [execution.md](execution.md) behavior 7.
5. **Knows its own settings — and itself.** Like every agent, its system prompt carries the dispatcher's config block ([routing-and-config.md](routing-and-config.md) behavior 8) naming the agent/model that actually resolved and how users tune them, and the self-description block (behavior 11) saying what Switchboard is, which agents exist, how residents work, and where the source and specs live — so "what are your settings?" and "how does your resident system work?" are answered from fact, never with a confabulated "I'm stateless" or a public-web 404.
6. **Issue writes are permission-gated per repo** ([github-tools.md](github-tools.md) item 3): `restrict.repos` against the requesting user's `repos` grant, checked before any API call; a refusal is reported to the user, not retried.

## Validation criteria

| Criterion | Proof |
|---|---|
| Toolset `assistant`, 8 turns, 5 min | `[unit]` `src/agents/registry.test.ts::general: the assistant toolset*` |
| `assistant` = GitHub reads + issue writes + `web_fetch` + `update_status`, nothing else | `[unit]` `src/tools/github.test.ts::toolset wiring::assistant has no shell*` |
| Declares no repo resource (coding/review declare `required`) | `[unit]` `src/agents/registry.test.ts::resource declarations: coding and review require a repo; general declares none` |
| With remote execution configured, a general ask provisions no sandbox and still answers | `[unit]` `src/core/dispatcher.test.ts::a general ask with remote execution configured provisions no sandbox and still answers` |
| Prompt names its GitHub tools, forbids claiming unperformed actions, redirects coding/review/research, never says "NO tools" | `[unit]` `src/agents/registry.test.ts::general's prompt names its GitHub tools*` |
| A plain mention opens an issue through `github_issue_create` and the reply quotes number + URL; a restricted repo refuses an ungranted user before the API | `[unit]` `src/core/dispatcher.test.ts::self-description in the system prompt … and the github_* tools::a plain mention opens an issue*`, `::the issue write is gated*` |
| Plain question → direct answer in seconds | `[agent]` `@switchboard what is a Durable Object?` — expect a concise answer, status card showing `general` and single-digit seconds. |
| Settings question → truthful answer naming the resolved agent/model and the tuning commands | `[unit]` `src/core/dispatcher.test.ts::config awareness in the system prompt::a default dispatch names the resolved agent+model and says config is tunable`; live check in [routing-and-config.md](routing-and-config.md) (behavior 8 `[agent]` row). Regression pin: general must never claim "stateless … no per-user or per-channel tuning". |
| Self question → answered from the About block | `[agent]` `@switchboard how does your resident repo system work, and how do I add a repo?` (fresh thread, no directive) — expect residents, `repo onboard`, the cap, and a pointer to `docs/reference/specs/resident-repos.md`; never "I have no access". |
| Issue ask → done, not redirected | `[agent]` `@switchboard open an issue on the switchboard app with the title "foo" and the body "bar"` → the reply quotes `<owner>/<repo>#<n>` + URL and the issue exists on GitHub. |
| Code-change / PR-review ask → honest redirect | `[agent]` `@switchboard fix the flaky test in acme/api and open a PR` (no `agent:` directive, fresh thread) — expect a redirect to `agent:coding`; no invented diffs, commands-to-run-yourself, or fabricated output. |
