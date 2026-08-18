# Switchboard — agent guide

Agent gateway: messages arrive over a channel, get routed to an agent, which runs on an inference provider and executes tools through an executor. Slack is one channel, not the architecture. Human-facing docs and diagrams: [README.md](README.md) — keep both in sync when you change architecture.

## Invariants (do not break)

1. **The core dispatcher never imports a platform SDK.** All Slack/Bolt code lives in `src/channels/slack.ts`. If you need something platform-specific in the core, extend `ChannelIO`/`IncomingMessage` instead.
2. **Every boundary is an interface with ≥2 implementations.** Channel (`ChannelIO`), provider (`Provider`), executor (`Executor`), agent (`AgentDef` data). New capability = new implementation behind the existing seam, not a special case in the core.
3. **Permission gates run against the *resolved* agent, post-resolution** (`dispatch()` in `src/core/dispatcher.ts`). Never add a code path that runs an agent without passing `config.canRunAgent`.
4. **IDs are platform-namespaced**: `slack:C0123` (channel scope), `slack:U0123` (user scope), `slack:C0123:<ts>` (thread key). Config scopes and permissions key on these. New adapters must namespace with their own prefix.
5. **Tools never touch the host directly** — they call `ctx.executor`. `LocalExecutor` is the only place local process/fs access is allowed for tool execution.
6. **State must survive restarts**: conversation context rebuilds from channel history; workspaces/sandboxes are recreatable (repos re-clone). Never introduce in-memory state a restart would lose silently.
7. **Model refs are `<provider>/<model>` strings** resolved through config layers (request directive > user > channel > defaults). Never hardcode a model in an agent or the core.

## Map

| Path | What | Notes |
|---|---|---|
| `src/core/types.ts` | Channel contract (`IncomingMessage`, `ChannelIO`, `StatusHandle`, `HistoryItem`) | The open-closed seam for platforms |
| `src/core/dispatcher.ts` | All orchestration: config commands, directives, resolution, permissions, history assembly, agent run | The only place these live |
| `src/channels/slack.ts` | Slack adapter (Bolt, Socket Mode) | Transport only: mention-strip, thread fetch, chunked replies, status edits |
| `src/cli.ts` | CLI adapter | Second channel; proof of the abstraction; use for local testing |
| `src/agents/registry.ts` | Agents as data: prompt + toolset + budgets | Add agents here; give them a default model in config |
| `src/providers/` | `Provider` interface, Anthropic + OpenAI-compatible adapters, registry | OpenAI-compatible endpoints are config-only additions |
| `src/execution/` | `Executor` interface, local + E2B backends, factory | E2B: per-thread sandbox, `data/sandboxes.json` maps thread→sandbox |
| `src/runner.ts` | Provider-blind agent loop (complete → run tools → append → repeat) | Turn budgets on the agent def |
| `src/config.ts` | Layered config, runtime overrides, permissions | `data/overrides.json` persists chat-set overrides |
| `src/directives.ts` | `agent:x model:p/m` inline parsing | |
| `config/config.example.yaml` | All config knobs, documented | Copy to `config/config.yaml` (gitignored) |
| `deploy/cloudflare/` | Worker+Container shim, mirrors `coreplanelabs/infrastructure` `terrateam/` pattern | Recommended deploy target |
| `Dockerfile`, `docker-compose.yml`, `fly.toml` | Same image, other deploy targets | |

## Working on this repo

- **Verify:** `npm run typecheck` must pass. Smoke-test core changes by driving `dispatch()` with a fake `ChannelIO` (see the pattern in PR history: write a throwaway `src/*.test.ts`, run with `npx tsx`, delete). No test framework is set up yet — don't add one casually.
- **Local run without Slack:** `npx tsx src/cli.ts "agent:review ..."` — full pipeline including executor selection.
- **`execution.type: e2b` paths need `E2B_API_KEY`** and have not been live-tested until someone runs one CLI request against a real sandbox.
- **Trust model:** agent `bash` executes model-generated commands. With `execution.type: local` the boundary is the container the bot runs in; with `e2b` it's the per-thread sandbox. Never put `GH_TOKEN` or other write-capable credentials on the bot host when `e2b` is enabled — they belong in the sandbox env only (`src/execution/factory.ts`).
- **Docs discipline:** architecture changes update README diagrams *and* this file. Deployment changes update the Deployment section + `deploy/`.

## Current state / known gaps

- E2B executor is typechecked but not yet exercised against a live sandbox.
- The Slack app has DM support wired but the recommended rollout keeps `im:*` scopes off initially.
- No token/cost accounting per request yet.
- No test framework — smoke tests are ad hoc.
