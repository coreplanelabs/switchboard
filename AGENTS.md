# Switchboard — the operating contract

Switchboard is an agent gateway: a message arrives over a channel (Slack, the CLI, HTTP, MCP), a dispatcher routes it to an agent, the agent runs on a model provider and executes tools through an executor it never touches directly. Slack is one channel, not the architecture.

This file is read by every agent that works on this repository — Claude Code, Switchboard's own review and coding agents, and a person asking "how do these people work?" It states how a change is made, the invariants it must keep, where things are, the commands that are the whole interface to the repo, and the rules for agents. Detail is one link away: [README.md](README.md) (engineering), [docs/](docs/README.md) (the human-facing tree, published at <https://docs.switchboard.coreplanelabs.dev>), [features/](features/README.md) (the behavioral contract).

## How a change is made

1. **The spec says what should be true.** Every behavior has a row in a spec under `features/`: the criterion, and its proof — a test named `file::describe::it`, a written procedure an agent runs live, or a `[gap]` linked to the issue that closes it. A change starts by writing or editing that row, in the same PR as the code. A spec describing code that no longer exists is a bug.
2. **A failing test, then the code.** Unit tests are the default proof. `npx vitest run --changed origin/main` is the working loop; `npm test` before pushing.
3. **`npm run fix`, then `npm run verify`.** `fix` regenerates every generated artifact and repairs lint and formatting. `verify` is the whole gate and exactly what CI runs — nothing lives only in CI, and a unit test over the workflow files keeps it that way.
4. **A PR written for the reader.** Conventional title (`feat(scope): …` — it becomes the squash commit and a changelog line; a required check refuses anything else). Body: two sentences a stranger can act on, then a Tour of the change in reading order with permalinks at the pushed head, the non-obvious decisions, and the validation with receipts. Docs describing changed behavior change in the same PR.
5. **Switchboard reviews it, in the open.** The PR is posted to `agent:review`; the verdict's findings are addressed or declined with a reason on the thread, the branch is rewritten so every commit is a reviewable unit, and review is re-requested at the new head. `LGTM` auto-approves; a person merges.
6. **Squash-merge, release, deploy.** The title is the commit. release-please accumulates a release PR; merging it tags the version and CI deploys only the Workers whose inputs changed. Why the loop has this shape: [How we work](docs/explanation/how-we-work.md).

## Invariants

1. **The core never imports a platform SDK.** Slack lives in `src/channels/slack.ts`; the core sees `ChannelIO` and `IncomingMessage`. Need something platform-specific? Extend the seam.
2. **Every boundary is an interface with at least two implementations** — channel, provider, executor, agent (as data), store. New capability = a new implementation behind the existing seam, never a special case in the core.
3. **Authorization is one table, asked once per request, against the *resolved* actor and agent.** Every command and every agent run passes `authorize` over the policy rows in `src/core/authz/`; adapters resolve identity, never authority; no registry command starts an agent run — that is `dispatch()`'s job alone.
4. **IDs are platform-namespaced** (`slack:C…`, `slack:U…`, `slack:C…:<ts>`). Config scopes, grants, and memory key on them; a new adapter brings its own prefix.
5. **Tools never touch the host.** They call `ctx.executor`; `LocalExecutor` is the only place local process or file access is allowed, and the bot process never shells out to `gh` — GitHub is the REST API on the App credential.
6. **State survives restarts.** Conversation context rebuilds from channel history; workspaces re-clone; anything durable lives in a store behind a seam. No in-memory state a restart would lose silently.
7. **Model refs are `<provider>/<model>` strings resolved through the config layers** (directive > thread > user > channel > defaults), and effort rides the same layers. Never hardcode a model or an effort in an agent or the core.

## Where things are

| Area | Path | Contract |
|---|---|---|
| Orchestration: directives, resolution, gates, history, the agent run | `src/core/dispatcher.ts` | `features/routing-and-config.md`, `run-loop.md` |
| Commands, once, every surface (chat, CLI, HTTP, MCP) | `src/core/commandRegistry.ts`, `commands/`, `commandSurface.ts` | `features/command-registry.md` |
| Authorization: actors, grants, the policy table, predicates | `src/core/authz/` | `features/authorization.md` |
| Runs: live registry, durable history, tracing, the run page and SSE | `src/core/runRegistry.ts`, `runStore.ts`, `runsService.ts`, `trace/`, `src/channels/liveView.ts` | `features/run-history.md`, `live-view.md`, `tracing.md` |
| Channels: Slack (transport only), HTTP, MCP ingress | `src/channels/` | `features/slack-channel.md`, `http-ingress.md`, `mcp-ingress.md` |
| Agents as data; providers; executors (local, sandbox, resident) | `src/agents/`, `src/providers/`, `src/execution/` | `features/agent-*.md`, `execution.md`, `resident-repos.md` |
| Memory, skills, external MCP tools, GitHub tools | `src/core/memory/`, `src/skills/`, `src/mcp/`, `src/tools/` | `features/memory.md`, `skills.md`, `mcp-tools.md`, `github-tools.md` |
| The dashboard (Vue) served from the bot's seed | `web/` | `features/live-view.md` |
| The four runtime Workers and the docs Worker | `deploy/cloudflare*/` | `features/release-and-deploy.md`, `docs-site.md` |
| Deploy selection, order, and live gate | `src/deploy/` | `features/release-and-deploy.md` |
| Human docs and their generated tables | `docs/`, `src/docs/` | `features/docs-site.md` |

Module by module: [Code map](docs/reference/code-map.md).

## Commands

The whole interface to this repository: deterministic, non-interactive, no credential unless it says so, failing fast by name when one is missing. CI calls nothing else.

<!-- generated:commands · npm run agents:gen — generated from package.json + project.json, do not edit by hand -->

| Command | What it does | When |
|---|---|---|
| `npm run build` | Compiles the bot to `dist/`. | `check:dist` and the Docker image run it; rarely by hand. |
| `npm run start` | Runs the compiled bot from `dist/`. | Production entry (the container's CMD). |
| `npm run dev` | Runs the bot from source with tsx. | Local development against a real Slack app. |
| `npm run typecheck` | TypeScript over the bot and its scripts, no emit. | After type-level changes; `verify:root` runs it. |
| `npm run test` | The whole vitest suite (bot, web, the plain-Node Worker tests) from one entry, after `deploy:gen`. | Before pushing. |
| `npm run cli` | The operator CLI over the command registry (`-- <group> <verb> …`), plus `ask` to drive the full pipeline without Slack. | Smoke tests, deploys, config, run history. |
| `npm run verify` | The whole gate: every root check, every workspace's verify, the site check — exactly what CI runs. | Before requesting review. ~4 min. |
| `npm run verify:root` | The bot package's gate: consistency checks, typecheck, lint, format, tests, dist. | When only the bot changed. |
| `npm run check:consistency` | The sub-second checks that generated and declared things equal the code (lockfile, sandbox pairs, skills, licenses, docs tables, spec bindings, project facts, this table). | After touching a generated or declared artifact; one CI leg. |
| `npm run ci:gate` | Reads the `needs` context of a CI fan-out and passes only when every leg succeeded. | CI only — the `bot` and `workers` gate jobs. |
| `npm run fix` | Regenerates every generated artifact and repairs lint and formatting. | Before committing; whenever `check:consistency` reports drift. |
| `npm run deploy:gen` | Renders each Worker's gitignored `wrangler.jsonc` from its template and the profile in force. | `test`, each Worker's `verify` and `deploy all` run it; by hand before `wrangler dev`. |
| `npm run deploy:check` | The rendered `wrangler.jsonc` files match `deploy:gen`. | When one looks hand-edited; change the template. |
| `npm run check:lockfile` | Every native package in the lockfile carries its Linux x64 and macOS arm64 variants. | After any `npm install`; the fix is `rm -rf node_modules && npm install`. |
| `npm run check:sandbox-pair` | Each Worker on the `cloudflare/sandbox` image pins `@cloudflare/sandbox` to exactly its Dockerfile tag. | After bumping either half of a pair. |
| `npm run check:pr-title` | Judges one PR title against Conventional Commits with the types release-please knows. | `-- "feat(scope): …"` before opening a PR; CI's `title` check runs it. |
| `npm run check:project-facts` | Every copy of the project's name, repository, docs URL and contact address equals `project.json`. | After editing `project.json` or a community file; part of `check:consistency`. |
| `npm run agents:gen` | Writes the Commands table in AGENTS.md from `package.json` and this file. | After adding or changing a script; part of `fix`. |
| `npm run clock:gen` | Regenerates the clock-read allowlist (`src/core/trace/clockAllowlist.json`) from the tree — empty since the ratchet reached zero, so a regeneration that is not `{}` names a new direct read. | Part of `fix`. |
| `npm run clock:check` | No production file reads the wall clock directly: the allowlist is empty and the tree agrees. | Part of `check:consistency`. |
| `npm run agents:check` | AGENTS.md is under its size budget, its Commands table is current, and every root script is described here. | Part of `check:consistency`. |
| `npm run lint` | ESLint over the whole tree. | `npm run fix` repairs what it can. |
| `npm run lint:fix` | ESLint with autofix. | Part of `fix`. |
| `npm run format` | Prettier over the whole tree (not Markdown). | Part of `fix`. |
| `npm run format:check` | Prettier in check mode. | Part of `verify:root`. |
| `npm run check:dist` | Builds, then proves the compiled entry points and the web bundle the image needs exist. | Part of `verify:root`. |
| `npm run check:site` | The docs site builds with no dead links and the pages the dashboard links to exist. | After a docs change; part of `verify`. |
| `npm run check:image` | Builds the Docker image. | After touching the Dockerfile or what it copies; needs Docker. Its own CI job. |
| `npm run skills:sync` | Vendors the skills listed in `skills/manifest.yaml`. | After changing the manifest; part of `fix`. |
| `npm run skills:check` | The vendored skills match the manifest byte for byte. | Part of `check:consistency`. |
| `npm run licenses:check` | Every production dependency's license is on the allowlist. | After adding a dependency. |
| `npm run docs:gen` | Writes the generated regions of the reference docs from the command registry. | After changing a command, flag, route, or config key; part of `fix`. |
| `npm run docs:check` | The generated doc regions equal what the code would generate. | Part of `check:consistency`. |
| `npm run specs:check` | Every `file::describe::it` proof in `features/*.md` names a real test; header paths exist; every `[gap]` links an issue. | After renaming a test or editing a spec; `-- --fix` makes truncated titles explicit. |
| `npm run docs:changed` | Says whether the last push touched the docs or their build (a CI job output). | CI only — gates the docs deploy. |
| `npm run deploy:targets` | Which Workers a PR's diff would deploy, as a job summary; on the release PR, a sticky comment. | CI only — the `deploy targets` job. |
| `npm run docs:dev` | Serves the docs site locally with live reload. | Writing docs. |
| `npm run docs:build` | Builds the docs site to `docs/.vitepress/dist`. | Rarely by hand; `verify -w docs` and the docs Worker's deploy run it. |
| `npm run web:preview` | Serves the dashboard bundle over fixtures for a visual check. | After a `web/` change. |
| `npm run load` | Load harness: `-- history\|resident\|sandbox\|e2e\|cards\|provider`. | Capacity receipts (features/load-harness.md). |

<!-- /generated:commands -->

Workspaces have their own `verify` (`-w web`, `-w docs`, `-w deploy/<worker>`); the root `verify` runs them all. Node is `.nvmrc`'s; `npm ci` at the root installs every workspace.

## Rules for agents

- **Comments are for the stranger.** A comment explains why the code is the way it is, checkable against the code. No links to private trackers, no people, no incident retellings — provenance belongs in the changelog and the decision records.
- **Never hand-edit a generated file or region.** Anything between `<!-- generated:… -->` markers, the vendored skills, the reference tables, and each Worker's `wrangler.jsonc` come from `npm run fix`; change the source and regenerate.
- **The spec follows the code, never the reverse.** Do not rename a test to satisfy a spec row; fix the row. A proof reference is exact or wildcarded (`title…`), never a truncation.
- **Tidy first.** Structural change (rename, move, extract) and behavioral change are separate commits, so each can be read on its own terms.
- **One coherent change per PR, rewritten before review.** No trails of fix-up commits; names and types tell the truth; a comment that was true earlier in the review cycle and is not now is removed.
- **Decisions are written down.** Non-obvious choices go in the PR's Decisions section; a choice that shapes the architecture becomes a dated record under `docs/plans/` with a status line, superseded rather than edited.
- **Tests move with code.** A moved module takes its tests and its spec rows with it in the same commit.
- **Credentials are never in the tree** and never on the bot host when a sandbox executes tools; a missing one fails fast by name. Config is `config/config.yaml` (gitignored); `config/config.example.yaml` documents every knob.
- **Run only what the Commands table names.** Need something else done? Add a script and describe it; `agents:check` refuses an undescribed one.

## Switchboard develops Switchboard

The rules above are written in terms of the product's own agents, because they are who follows them: `agent:review` reviews every PR (read-only, one verdict, never a merge), `agent:coding` implements issues with the vendored skills as house style, `agent:ship` runs the loop end to end, every run has a page, and `friction propose` files the process's own improvement issues. How each behaves: [How we work](docs/explanation/how-we-work.md#switchboard-develops-switchboard).

## Working locally

Node from `.nvmrc`, `npm ci`, `npm run verify`. `npm run cli -- ask "agent:review <PR url>"` drives the pipeline without Slack; `npm run cli -- <group> <verb> --help` for any command. The `bash` tool runs model-generated commands inside the executor's boundary — never put write-capable credentials where the model can reach them. Production, sizing, and what is deliberately off: [Operate production](docs/how-to/operate-production.md), [Capacity and sizing](docs/explanation/capacity-and-sizing.md), [Known limits](docs/explanation/known-limits.md).
