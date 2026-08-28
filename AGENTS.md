# Switchboard — agent guide

Agent gateway: messages arrive over a channel, get routed to an agent, which runs on an inference provider and executes tools through an executor. Slack is one channel, not the architecture. Human-facing docs and diagrams: [README.md](README.md) — keep both in sync when you change architecture.

## Invariants (do not break)

1. **The core dispatcher never imports a platform SDK.** All Slack/Bolt code lives in `src/channels/slack.ts`. If you need something platform-specific in the core, extend `ChannelIO`/`IncomingMessage` instead.
2. **Every boundary is an interface with ≥2 implementations.** Channel (`ChannelIO`), provider (`Provider`), executor (`Executor`), agent (`AgentDef` data). New capability = new implementation behind the existing seam, not a special case in the core.
3. **Permission gates run against the *resolved* agent, post-resolution** (`dispatch()` in `src/core/dispatcher.ts`). Never add a code path that runs an agent without passing `config.canRunAgent`.
4. **IDs are platform-namespaced**: `slack:C0123` (channel scope), `slack:U0123` (user scope), `slack:C0123:<ts>` (thread key). Config scopes and permissions key on these. New adapters must namespace with their own prefix.
5. **Tools never touch the host directly** — they call `ctx.executor`. `LocalExecutor` is the only place local process/fs access is allowed for tool execution. Resident environments keep this invariant by being remote: `ResidentExecutor` speaks HTTPS to the resident Worker, and even the dispatcher's repo/PR resolution uses the GitHub REST API — never a `gh` shell-out from the bot process.
6. **State must survive restarts**: conversation context rebuilds from channel history; workspaces/sandboxes are recreatable (repos re-clone). Never introduce in-memory state a restart would lose silently.
7. **Model refs are `<provider>/<model>` strings** resolved through config layers (request directive > user > channel > defaults). Never hardcode a model in an agent or the core.

## Map

| Path | What | Notes |
|---|---|---|
| `src/core/types.ts` | Channel contract (`IncomingMessage`, `ChannelIO`, `StatusHandle`, `HistoryItem`) | The open-closed seam for platforms |
| `src/core/structuredMessage.ts` | Structured-output zod schema + `ChannelFormatter` seam + `PlainTextFormatter` | Channel-agnostic output blocks; `SlackFormatter` in `src/channels/slackFormatter.ts` is the 2nd impl (invariant 2). See `features/channel-formatter.md` |
| `src/core/structuredOutput.ts` | Validation + fixed-retry self-heal loop + provider-backed producer | Flag-gated (`output.structured`, default off); wired in `dispatcher.sendAnswer` |
| `src/core/dispatcher.ts` | All orchestration: config commands, directives, resolution, permissions, history assembly, agent run | The only place these live |
| `src/core/repoContext.ts` | Pre-model repo/ref resolution (slug/URL/PR in the message, thread history) | Feeds resident selection; PR→ref via one REST call, never `gh` |
| `src/core/repoCommands.ts` | `repo onboard/offboard/reconfigure/rebuild/list` chat commands | Gated by `canManageRepos` (KTD9 fail-closed); talks to the resident Worker's admin routes |
| `src/core/runRegistry.ts` | In-memory, live-only run registry (per-run id+token, bounded backlog, TTL eviction, constant-time gate, token-gated `snapshot`) | Backs the external live-view page; `defaultRunRegistry` singleton shared with the dispatcher |
| `src/core/runFriction.ts` | Run-friction analyzer (#84): pure `analyzeRunFriction(events)` → structured diagnosis of delay causes + text report | Analysis only, no side effects; surfaced via `GET /runs/:id/friction` and `src/frictionCli.ts`; see `features/run-friction.md` |
| `src/core/memory/` | Cross-session memory (#85): `MemoryStore` seam, read path (types, keyword+recency scorer, scope deriver), write path (`reflection.ts`: post-reply async distillation on `memory.model`, validated + redacted), the shared `engine.ts` (rank + dedup/supersede plan), and three stores: `Null`, `InMemory`, and the durable `WorkerMemoryStore` (HTTPS client to `deploy/cloudflare-memory/`). Flag-gated OFF by default | `NullMemoryStore` when disabled → model input byte-identical to memory-off, nothing written; `buildMemoryStore` in `index.ts` picks the Worker store when `memory.worker` + its bearer are set, else in-process with a startup warning; reflections are fire-and-forget, awaited only by the drain; see `features/memory.md` |
| `deploy/cloudflare-memory/` | Memory Worker: one SQLite-backed Durable Object per scopeKey (FTS5 candidate match), `POST /retrieve` + `POST /write` behind a constant-time `MEMORY_TOKEN` bearer | Imports `src/core/memory/engine.ts` by relative path so the durable and in-process stores run ONE algorithm; tests run inside workerd (`npm test` there, in CI) |
| `src/skills/` | Skill loading (#100): `SkillStore` seam + `Bundled`/`InMemory` stores + frontmatter parse; seeded skills under `skills/<slug>/SKILL.md`. `list_skills`/`use_skill` tools in `src/tools/skills.ts` | Progressive-disclosure block appended per agent in the dispatcher; bodies load on demand; per-agent scoping via frontmatter `agents`. See `features/skills.md` |
| `src/channels/liveView.ts` | Live-view surface: token-gated `GET /runs/:id` (HTML) + `/runs/:id/events` (SSE) | Capability-URL auth (not bearer); consumes the run-visibility stream; see `features/live-view.md` |
| `src/channels/residentsView.ts` | Residents dash: Access-gated `GET /residents` (index) + `/residents/<owner>/<name>` (detail) — the browser twin of `repo list` | Reads the resident admin `/residents` route live per request; never caches, never renders the bearer; see `features/resident-repos.md` item 42 |
| `src/channels/slack.ts` | Slack adapter (Bolt, Socket Mode) | Transport only: mention-strip, thread fetch, chunked replies, status edits |
| `src/cli.ts` | CLI adapter | Second channel; proof of the abstraction; use for local testing |
| `src/frictionCli.ts` | `npx tsx src/frictionCli.ts <run.jsonl \| sse-capture>` — read-only friction report over a saved run stream | Accepts JSON lines or a `curl`ed `/runs/:id/events` capture |
| `src/agents/registry.ts` | Agents as data: prompt + toolset + budgets | Add agents here; give them a default model in config |
| `src/providers/` | `Provider` interface, Anthropic + OpenAI-compatible adapters, registry | OpenAI-compatible endpoints are config-only additions |
| `src/execution/` | `Executor` interface; local, E2B, Cloudflare Sandbox, and resident backends; factory | E2B keys sandboxes via `data/sandboxes.json`; Cloudflare keys them on `X-Thread-Key` through the proxy Worker in `deploy/cloudflare-sandbox/` |
| `src/execution/resident.ts` | `ResidentExecutor`: attach-on-open client for the resident Worker | Warm-gated selection + named fallback live in `factory.ts` |
| `src/runner.ts` | Provider-blind agent loop (complete → run tools → append → repeat) | Turn budgets on the agent def |
| `src/config.ts` | Layered config, runtime overrides, permissions | `data/overrides.json` persists chat-set overrides |
| `src/directives.ts` | `agent:x model:p/m` inline parsing | |
| `config/config.example.yaml` | All config knobs, documented | Copy to `config/config.yaml` (gitignored) |
| `deploy/cloudflare/` | Worker+Container shim, mirrors `coreplanelabs/infrastructure` `terrateam/` pattern | Recommended deploy target |
| `deploy/cloudflare-resident/` | Resident Worker: always-warm per-repo DOs on Cloudflare Sandbox 1.0, R2 snapshots, refresh alarms + watchdog cron | Live at switchboard-resident.coreplanelabs.dev; contract in `features/resident-repos.md`; holds its own GitHub App secrets (second credential domain) |
| `Dockerfile`, `docker-compose.yml`, `fly.toml` | Same image, other deploy targets | |

## Feature specs — the behavioral contract (`features/`)

[`features/`](features/README.md) is the versioned behavioral contract: one file per feature stating expected behavior, validation criteria, and how each criterion is proven — `[unit]` (a named test), `[agent]` (written instructions an agent runs against the live deployment), or `[gap]` (known-unproven, a work item). Because the files live in the repo, **any git SHA ties the code to the validation criteria that described it at that moment** — agents can reference behavior for any point in history.

Non-negotiable discipline:

1. **Same-PR updates.** Any PR that changes behavior updates the matching feature file in that PR (criteria added/edited/pruned). A feature file describing removed code is a bug.
2. **TDD from the spec.** New behavior: write/extend the feature file's criteria → write failing tests → implement to green. Prefer unit tests; use `[agent]` instructions only where a unit test genuinely can't prove it, and make those instructions literally executable (exact messages/commands + expected observable result).
3. **Receipts.** When an `[agent]` criterion is validated live, date it and link the evidence in the feature file.
4. Milestones live in `features/README.md`; current: [milestone 1 — agents work as designed, obviously better than Claude Tag](features/milestone-1-vs-claude-tag.md).

## Working on this repo

- **Verify:** `npm run typecheck` and `npm test` (vitest, `src/**/*.test.ts`) must both pass. Tests are the proof layer for feature specs — see the section above. For exploratory smoke tests, `npx tsx src/cli.ts` drives the full pipeline.
- **Local run without Slack:** `npx tsx src/cli.ts "agent:review ..."` — full pipeline including executor selection.
- **`execution.type: e2b` paths need `E2B_API_KEY`** and have not been live-tested until someone runs one CLI request against a real sandbox.
- **Trust model:** agent `bash` executes model-generated commands. With `execution.type: local` the boundary is the container the bot runs in; with `e2b` it's the per-thread sandbox. Never put `GH_TOKEN` or other write-capable credentials on the bot host when `e2b` is enabled — they belong in the sandbox env only (`src/execution/factory.ts`).
- **Docs discipline:** architecture changes update README diagrams *and* this file. Deployment changes update the Deployment section + `deploy/`.

## Current state / known gaps

- The Cloudflare execution path IS live-tested: the resident Worker (`deploy/cloudflare-resident/`) runs at switchboard-resident.coreplanelabs.dev with `repo:jshttp/vary` (public) and `repo:coreplanelabs/switchboard` (private) onboarded, and its attach/exec/read/write plane plus onboard/offboard/rebuild lifecycle have live receipts in `features/resident-repos.md` (validated 2026-08-26; private onboard 2026-08-28).
- `GITHUB_APP_*` secrets ARE set on the resident Worker (2026-08-28; it is a second copy of the bot's App credential — rotate both). Onboard's installation-membership check runs for real and private repos clone via minted installation tokens (`coreplanelabs/switchboard` reached `warm`). Still `[gap]` in `features/resident-repos.md`: the not-in-installation refusal, the cross-repo token-scope proof, and a push from a resident thread.
- The E2B executor path is typechecked but still not exercised against a live sandbox.
- The Slack app has DM support wired but the recommended rollout keeps `im:*` scopes off initially.
- No token/cost accounting per request yet.
- CI (`.github/workflows/ci.yml`) runs typecheck + tests + the dist-excludes-tests check + the sandbox-worker typecheck on every PR and on main.
- Feature-spec `[gap]` items (see `features/*.md`) are the known-unproven criteria backlog.
