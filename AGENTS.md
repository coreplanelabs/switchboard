# Switchboard — the operating contract

Switchboard is an agent gateway: Slack, the CLI, HTTP or MCP sends a message; a dispatcher routes it to an agent, whose provider-backed run uses tools through an executor it never touches directly. Slack is one channel, not the architecture.

Read this first. Details: [README.md](README.md), [docs](docs/README.md) at <https://openswitchboard.dev> and the [behavioral specs](docs/reference/specs/README.md).

## How a change is made

1. **The spec says what should be true.** Every behavior has a row in a spec under `docs/reference/specs/`: the criterion and its proof — a `file::describe::it` test, a procedure an agent runs live, or a `[gap]` still to be proven. A change starts with that row, in the same PR as the code. A spec describing code that no longer exists is a bug — and the review agent reads the specs a PR touches (`specs:coverage`) and files a contradiction as a finding.
2. **A failing test, then the code.** Unit tests are the default proof. The loop is `npx vitest run` on the test files you touched, by name, once before the push — never `--changed`, never a directory: on a moving base `--changed` is most of the suite, and on the shared resident that is the memory incident the coding contract exists to prevent. The full suite and typecheck are CI's gate and run only there. Local human session: `npm test` before pushing.
3. **`npm run fix`, then the checks the change needs.** `fix` regenerates every generated artifact and repairs lint and formatting. CI runs the tests, types, formatting and `npm run verify` on every push, so a pipeline agent never runs them whole — passing them is not its criterion; it validates its own change at the changed-set scope (`npx prettier --check` on the changed files, `tsc --noEmit -p` the touched tsconfig under `NODE_OPTIONS=--max-old-space-size=6144`, `npm run hygiene:check`, `npm run specs:check`) and uses judgement beyond that, not a checklist. Local human session: `npm run verify` before requesting review — it is exactly what CI runs; nothing lives only in CI, and a unit test over the workflow files keeps it so.
4. **A PR written for the reader.** The title is the changelog line, 72 characters at most: `type(scope): what a reader can now do or expect`, scope from the code map's Areas, `!` plus a migration note when it breaks ([the rule](CONTRIBUTING.md#the-pr-title-is-the-changelog-line)); a required check refuses the rest. Body: the fixed-size map of [pr-description.md](docs/reference/specs/pr-description.md); decisions and receipts fold below. Docs for changed behavior change in the same PR.
5. **Switchboard reviews it, in the open.** The PR is posted to `agent:review`; findings are addressed or declined with a reason, the branch rewritten into reviewable commits, review re-requested at the new head. `LGTM:` auto-approves where the repo has opted in; a person merges.
6. **Squash-merge, release, deploy.** The title is the commit. release-please accumulates a release PR; merging it tags the version and CI deploys only the Workers whose inputs changed.

## Invariants

1. **The core never imports a platform SDK.** Slack lives in `src/channels/slack.ts`; the core sees `ChannelIO` and `IncomingMessage`. Platform-specific? Extend a seam.
2. **Every boundary is an interface with at least two implementations** — channel, provider, executor, agent (as data), store. A new capability is a new implementation behind the seam, never a special case in the core.
3. **Authorization is one table, asked once per request, against the *resolved* actor and agent.** Every command and every agent run passes `authorize` over the policy rows in `src/core/authz/`; adapters resolve identity, never authority; no registry command starts an agent run — that is `dispatch()`'s job alone.
4. **IDs are platform-namespaced** (`slack:C…`, `slack:U…`, `slack:C…:<ts>`). Config scopes, grants, and memory key on them; a new adapter brings its own prefix.
5. **Tools never touch the host.** They call `ctx.executor`; `LocalExecutor` is the only place local process or file access is allowed; the bot never shells out to `gh` — GitHub is the REST API on the App credential.
6. **State survives restarts.** Conversation context rebuilds from channel history; workspaces re-clone; anything durable lives in a store behind a seam. No in-memory state a restart loses silently.
7. **Model refs are `<provider>/<model>` strings resolved through the config layers** (directive > thread > user > channel > defaults), and effort rides the same layers. Never hardcode a model or an effort in an agent or the core.

## Where things are

The user's nouns: the [Vocabulary](docs/reference/vocabulary.md). Module by module: the [Code map](docs/reference/code-map.md). The behavior each area must keep: its spec under [`docs/reference/specs/`](docs/reference/specs/README.md). The why behind it: the [decision records](docs/explanation/design-decisions.md). When they disagree with the code, one is wrong; the checks (`specs:check`, `decisions:check`, `docs:check`) say which.

## Commands

The repo's whole interface: deterministic, non-interactive, no credential unless it says so, failing fast by name. CI calls nothing else.

<!-- generated:commands · npm run agents:gen — generated from package.json + project.json, do not edit by hand -->

| Command | What it does | When |
|---|---|---|
| `npm run build` | Compiles the bot to `dist/`. | `check:dist` and the Docker image run it; rarely by hand. |
| `npm run start` | Runs the compiled bot from `dist/`. | Production entry (the container's CMD). |
| `npm run dev` | Runs the bot from source with tsx. | Local development against a real Slack app. |
| `npm run typecheck` | TypeScript over the bot and its scripts, no emit. | After type-level changes; `verify:root` runs it. A pipeline agent scopes it to the touched tsconfig. |
| `npm run test` | The whole vitest suite from one entry, after `deploy:gen`. | Local sessions, before pushing; a pipeline agent runs the changed set — the full suite is CI's. |
| `npm run cli` | The operator CLI over the command registry (`-- <group> <verb> …`), plus `ask` to drive the full pipeline without Slack. | Smoke tests, deploys, config, run history. |
| `npm run verify` | The whole gate: every check, every workspace — exactly what CI runs. | Local sessions, before requesting review. ~4 min. A pipeline agent leaves it to CI. |
| `npm run verify:root` | The bot package's gate: consistency checks, typecheck, lint, format, tests, dist. | When only the bot changed. |
| `npm run check:consistency` | The sub-second checks that generated and declared things equal the code, this table included. | After touching a generated or declared artifact; one CI leg. |
| `npm run ci:gate` | Reads the `needs` context of a CI fan-out and passes only when every leg succeeded. | CI only — the `bot` and `workers` gate jobs. |
| `npm run fix` | Regenerates every generated artifact and repairs lint and formatting. | Before committing; whenever `check:consistency` reports drift. |
| `npm run deploy:gen` | Renders each Worker's gitignored `wrangler.jsonc` from its template and the profile in force. | `test`, each Worker's `verify` and `deploy all` run it; by hand before `wrangler dev`. |
| `npm run deploy:check` | The rendered `wrangler.jsonc` files match `deploy:gen`. | When one looks hand-edited; change the template. |
| `npm run check:lockfile` | Native packages carry Linux x64 and macOS arm64 variants; records mirror their `package.json`. | After a manifest edit or `npm install`; failures name the fix. |
| `npm run check:sandbox-pair` | Each Worker on the `cloudflare/sandbox` image pins `@cloudflare/sandbox` to exactly its Dockerfile tag. | After bumping either half of a pair. |
| `npm run check:pr-title` | Judges one PR title as the changelog line: grammar, type, scope, `!`. | `-- "feat(scope): …"` before opening a PR; CI's `title` check. |
| `npm run pr-title:gen` | Writes the title gate's types and scopes from the release config and the code map. | Part of `fix`. |
| `npm run pr-title:check` | The committed title vocabulary equals its two sources. | Part of `check:consistency`. |
| `npm run check:project-facts` | Every copy of the project's names, repository, docs URL and contact address equals `project.json`; its description, topics and npm package fit their rules. | After editing `project.json` or a community file; part of `check:consistency`. |
| `npm run check:registry-drift` | Every example-config model ref still resolves against the pinned pi registry. | After a pi bump; part of `check:consistency`. |
| `npm run agents:gen` | Writes the Commands table in AGENTS.md from `package.json` and this file. | After adding or changing a script; part of `fix`. |
| `npm run clock:gen` | Regenerates both clock allowlists: wall-clock reads (empty) and duration literals outside `src/core/budgets.ts`. | Part of `fix`. |
| `npm run clock:check` | No production file reads the wall clock directly or gained a duration literal outside `src/core/budgets.ts`; both allowlists match the tree. | Part of `check:consistency`. |
| `npm run agents:check` | AGENTS.md is under its size budget, its Commands table is current, and every root script is described here. | Part of `check:consistency`. |
| `npm run lint` | ESLint over the whole tree. | `npm run fix` repairs what it can. |
| `npm run lint:fix` | ESLint with autofix. | Part of `fix`. |
| `npm run format` | Prettier over the whole tree (not Markdown). | Part of `fix`. |
| `npm run format:check` | Prettier in check mode. | Part of `verify:root`. |
| `npm run check:dist` | Builds, then proves the compiled entry points and the web bundle the image needs exist. | Part of `verify:root`. |
| `npm run check:site` | Every page the dashboard links to is in the built site, and its home page reads `displayName`. | After a docs change; part of `verify`. |
| `npm run check:image` | Builds every Worker's image. | After touching a Dockerfile; needs Docker. One CI leg per image. |
| `npm run skills:sync` | Vendors the skills listed in `skills/manifest.yaml`. | After changing the manifest; part of `fix`. |
| `npm run skills:check` | The vendored skills match the manifest byte for byte. | Part of `check:consistency`. |
| `npm run licenses:check` | Every production dependency's license is on the allowlist. | After adding a dependency. |
| `npm run check:deps-drift` | Installed node_modules match the lockfile: drift fails by name. | Part of `check:consistency`. |
| `npm run docs:gen` | Writes the generated regions of the reference docs from the command registry. | After changing a command, flag, route, or config key; part of `fix`. |
| `npm run docs:check` | The generated doc regions equal what the code would generate. | Part of `check:consistency`. |
| `npm run specs:check` | Every `file::describe::it` proof in `docs/reference/specs/*.md` names a real test; header paths exist. | After renaming a test or editing a spec; `-- --fix` makes truncated titles explicit. |
| `npm run specs:coverage` | Maps a change's paths to the specs whose headers cover them, then lists paths no spec covers. | `-- --changed origin/main...HEAD [--test-guard]` before review; `-- --require` fails on an uncovered path; `-- --json` for machines. |
| `npm run decisions:check` | Every record under `docs/decisions/` and `docs/plans/` has a valid `status`, a superseded one names its successor, an accepted body only gains `## Amended`. | Part of `check:consistency`; a failing record is superseded or amended, never edited. |
| `npm run hygiene:check` | The public tree's imprint (company, people, trackers, plan ids, ids, dates) equals the recorded list, which only shrinks. | Part of `check:consistency`. New hit: rewrite the line or allow it by name. |
| `npm run hygiene:gen` | Records the tree's remaining imprint after a scrub; refuses growth unless `-- --force`. | Part of `fix`; new imprint fails it like `hygiene:check`. |
| `npm run vocabulary:check` | No internal word prints on a user surface; the baseline only shrinks. | Part of `check:consistency`; a hit is rewritten in the user's nouns. |
| `npm run vocabulary:gen` | Records the remaining internal words; refuses growth unless `-- --force`. | Part of `fix`. |
| `npm run user-message:check` | No user-facing statement delegates recovery. | Part of `check:consistency`; the baseline only shrinks. |
| `npm run docs:changed` | Says whether the last push touched the docs or their build (a CI job output). | CI only — gates the docs deploy. |
| `npm run deploy:targets` | Which Workers a PR's diff would deploy, as a job summary; on the release PR, a sticky comment. | CI only — the `deploy targets` job. |
| `npm run docs:dev` | Serves the docs site locally with live reload. | Writing docs; `-- --port <n>` picks the port. |
| `npm run docs:build` | Builds the docs site to `docs/.vitepress/dist`. | Rarely by hand; `verify -w docs` and the docs Worker's deploy run it. |
| `npm run web:preview` | Serves the dashboard bundle over fixtures for a visual check. | After a `web/` change. |
| `npm run screenshots:gen` | Renders the dashboard screenshots whose inputs changed, both themes, recording input hashes in the manifest (`--force`: all). | After a `web/` or fixture change; needs `npx playwright-core install chromium`, so not in `fix`. |
| `npm run screenshots:check` | Each surface's inputs still hash to what its screenshots were rendered from — no browser. | Part of `check:consistency`. |
| `npm run load` | Load harness: `-- history\|resident\|sandbox\|e2e\|cards\|provider\|pi\|route\|intake\|door`. | Capacity receipts (docs/reference/specs/load-harness.md). |

<!-- /generated:commands -->

Each workspace has its own `verify` (`-w web|docs|deploy/<worker>|packages/switchboard`); the root one runs them all.

## Rules for agents

- **Comments are for the stranger.** A comment explains why, checkable against the code. No private trackers, people or incident retellings — provenance belongs in the changelog and the decision records; `hygiene:check` enforces it.
- **Never hand-edit a generated file or region.** Generated regions, the vendored skills, the reference tables and each Worker's `wrangler.jsonc` come from `npm run fix`; change the source and regenerate.
- **The spec follows the code, never the reverse.** Do not rename a test to satisfy a spec row; fix the row. A proof reference is exact or wildcarded (`title…`), never a truncation.
- **Tidy first.** Structural change (rename, move, extract) and behavioral change are separate commits, each readable on its own.
- **One coherent change per PR, rewritten before review.** No fix-up trails; names and types tell the truth; a comment that stopped being true during review is removed.
- **Decisions are written down.** Non-obvious choices go in the PR's Decisions section; one that shapes the architecture becomes a record under `docs/decisions/` (a plan under `docs/plans/`), never edited — superseded, and `decisions:check` holds that line.
- **Tests move with code.** A moved module takes its tests and spec rows with it, same commit.
- **Credentials are never in the tree** and never on the bot host when a sandbox executes tools; a missing one fails fast by name. `config/config.example.yaml` documents every knob of the gitignored `config/config.yaml`.
- **Run only what the Commands table names.** Need more? Add and describe a script; `agents:check` refuses an undescribed one.

## Switchboard develops Switchboard

The product's own agents follow these rules: `agent:review` reviews every PR (read-only, never a merge), `agent:coding` implements issues, `agent:ship` runs the loop end to end, `friction propose` files the process's improvement issues. Details: [How we work](docs/explanation/how-we-work.md#switchboard-develops-switchboard).

## Working locally

Setup, the three test passes and the PR expectations: [CONTRIBUTING.md](CONTRIBUTING.md). Production, sizing and deliberate gaps: [Operate production](docs/how-to/operate-production.md), [Capacity and sizing](docs/explanation/capacity-and-sizing.md), [Known limits](docs/explanation/known-limits.md). One rule for every local run: `bash` runs model-generated commands inside the executor's boundary, so write-capable credentials stay out of the model's reach.
