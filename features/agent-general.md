# Agent: general

The default fallback — a plain, fast passthrough to the configured model. No tools, one turn. Exists so casual questions get instant answers and so misrouted requests fail cheap and legible.

- **Code**: `src/agents/registry.ts` (`general`), default model in `config/config.production.yaml`
- **Docs**: [README — Agents](../README.md#agents)
- **Budgets**: 1 turn / 5 min / 16k tokens · toolset `none`
- **Receipts**: https://github.com/coreplanelabs/switchboard/issues/224

## Behavior

1. Answers directly and concisely in Slack-friendly formatting; no tool access of any kind.
2. Runs on a fast/cheap model by default (production: haiku) — the speed *is* the feature.
3. Never claims tool abilities it lacks and never guesses at repo URLs, file contents, or command output; when a request needs tools it redirects to `agent:coding` / `agent:review` explicitly (the system prompt names them).
4. **Declares no resources** (`AgentDef.resources` omits `repo`): a general ask never creates, reconnects, or touches a sandbox or workspace — even when remote execution (E2B/Cloudflare) is configured, and even when the sandbox credential is missing. See [execution.md](execution.md) behavior 7.
5. **Knows its own settings.** Like every agent, its system prompt carries the dispatcher's config block ([routing-and-config.md](routing-and-config.md) behavior 8) naming the agent/model that actually resolved and how users tune them — so "what are your settings?" is answered from fact, never with a confabulated "I'm stateless".

## Validation criteria

| Criterion | Proof |
|---|---|
| Toolset `none`, 1 turn, 5 min | `[unit]` `src/agents/registry.test.ts::general` |
| Declares no repo resource (coding/review declare `required`) | `[unit]` `src/agents/registry.test.ts::resource declarations: coding and review require a repo; general declares none` |
| With remote execution configured, a general ask provisions no sandbox and still answers | `[unit]` `src/core/dispatcher.test.ts::a general ask with remote execution configured provisions no sandbox and still answers` |
| Prompt names the other agents and states it has no tools | `[unit]` `src/agents/registry.test.ts::general's prompt redirects` (regression pin: a redirect-free prompt leads general to invent a repo URL and tell the user to run git themselves) |
| Plain question → direct answer in seconds | `[agent]` `@switchboard what is a Durable Object?` — expect a concise answer, status card showing `general` and single-digit seconds. |
| Settings question → truthful answer naming the resolved agent/model and the tuning commands | `[unit]` `src/core/dispatcher.test.ts::config awareness in the system prompt::a default dispatch names the resolved agent+model and says config is tunable`; live check in [routing-and-config.md](routing-and-config.md) (behavior 8 `[agent]` row). Regression pin: general must never claim "stateless … no per-user or per-channel tuning". |
| Tool-needing request → honest redirect | `[agent]` `@switchboard clone repo X and list its files` (no `agent:` directive, fresh thread) — expect it to say it has no tools and point at `agent:coding` — no invented URLs, commands-to-run-yourself, or fabricated output. |
