# Agent: general

The default fallback — a plain, fast passthrough to the configured model. No tools, one turn. Exists so casual questions get instant answers and so misrouted requests fail cheap and legible.

- **Code**: `src/agents/registry.ts` (`general`), default model in `config/config.production.yaml`
- **Docs**: [README — Agents](../README.md#agents)
- **Budgets**: 1 turn / 5 min / 16k tokens · toolset `none`

## Behavior

1. Answers directly and concisely in Slack-friendly formatting; no tool access of any kind.
2. Runs on a fast/cheap model by default (production: haiku) — the speed *is* the feature.
3. Never claims tool abilities it lacks and never guesses at repo URLs, file contents, or command output; when a request needs tools it redirects to `agent:coding` / `agent:review` explicitly (the system prompt names them).
4. **Declares no resources** (`AgentDef.resources` omits `repo`): a general ask never creates, reconnects, or touches a sandbox or workspace — even when remote execution (E2B/Cloudflare) is configured, and even when the sandbox credential is missing. See [execution.md](execution.md) behavior 7.

## Validation criteria

| Criterion | Proof |
|---|---|
| Toolset `none`, 1 turn, 5 min | `[unit]` `src/agents/registry.test.ts::general` |
| Declares no repo resource (coding/review declare `required`) | `[unit]` `src/agents/registry.test.ts::resource declarations: coding and review require a repo; general declares none` |
| With remote execution configured, a general ask provisions no sandbox and still answers | `[unit]` `src/core/dispatcher.test.ts::a general ask with remote execution configured provisions no sandbox and still answers` |
| Prompt names the other agents and states it has no tools | `[unit]` `src/agents/registry.test.ts::general's prompt redirects` (regression pinned: on 2026-08-21 the redirect-free prompt led general to invent a repo URL and tell the user to run git themselves) |
| Plain question → direct answer in seconds | `[agent]` `@switchboard what is a Durable Object?` — expect a concise answer, status card showing `general` and single-digit seconds. (Validated 2026-08-21: 2s.) |
| Tool-needing request → honest redirect | `[agent]` `@switchboard clone repo X and list its files` (no `agent:` directive, fresh thread) — expect it to say it has no tools and point at `agent:coding` — no invented URLs, commands-to-run-yourself, or fabricated output. |
