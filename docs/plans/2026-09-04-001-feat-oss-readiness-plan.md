---
title: Open-source readiness - Plan
type: feat
date: 2026-09-04
artifact_contract: ce-unified-plan/v1
artifact_readiness: review-ready
product_contract_source: session 2026-09-04 (Justin + Claude)
execution: code
---

# Open-source readiness - Plan

## Goal Capsule

- **Objective**: Turn `coreplanelabs/switchboard` into coreplanelabs' first public open-source project: a repo a stranger understands in 60 seconds, runs in 10 minutes, can contribute to with confidence, and that carries no trace of the company's internal workflow, other products, incidents, or private trackers. The product must adapt to what a deployment has turned on (residents, memory, run history, MCP, costs, schedules, Cloudflare) rather than assume our production shape.
- **Authority**: this plan > `features/*.md` and AGENTS.md invariants > issue prose. The seven AGENTS.md invariants are preserved verbatim; nothing here changes what the product does for a Slack user.
- **Stop conditions**: a scrub that would require rewriting a test's behavior (not its fixture names); a composability change that would fork the dispatcher; any decision in the D-list below that has not been taken.
- **Execution profile**: each phase is a PR (or a `gh stack` series), reviewed through the pr-lifecycle loop. Hygiene rules become CI checks in the same PR that introduces them, so nothing here can regress after the flip.
- **Tail ownership**: the go-public flip and the human review passes (README, landing page, tutorials, Slack screenshots) are Justin's; everything else ships autonomously once the D-list is answered.

---

## Where the repo is today (audit, 2026-09-04)

| Fact | Value |
|---|---|
| Visibility / license | private, no LICENSE, `"private": true`, no CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CODEOWNERS, templates, Dependabot, CodeQL; secret scanning off; wiki on, discussions off; no branch protection (one ruleset `main-ci-required`) |
| History | 489 commits, 479 by Justin, 329 PRs, 135 issues (43 open). **No real secrets in history**: the only hits are test fixtures; the old `secrets.txt` files were name lists; the Access AUD is public by design |
| Source | 40 k lines TS in `src/`, 44 k lines tests; 3,554 bot tests green in 4 s; 297 web/worker tests; `dispatcher.ts` is 2,463 lines |
| Company imprints in `src/` | 385 `coreplane`, 108 `justin`, 39 `nominal`, 658 `#NNN` issue refs, 482 plan-decision ids (`KTD…`/`KD…`/`OQ…`/`U…`), 93 dated incident narratives in non-test code |
| Imprints elsewhere | `features/` 182 `coreplane` + 290 issue refs across 152 k words; `deploy/` 60 + 113; `docs/` 31 + 23; `config/` 14 + 17 |
| Hardcoded org constants | memory `ORG_RESOURCE = "coreplanelabs"`, `SWITCHBOARD_REPO`, self-description "coreplanelabs' agent gateway", `SHIP_PR_AUTHOR` (bot login + id), `DOCS_BASE_URL`, `PRODUCTION_ACCOUNT_ID`, `BOT_HEALTH_URL`, `BOT_ADMIN_RESTART_URL`, `RESIDENT_CAP_NOTE`, every `wrangler.jsonc` account id + `coreplanelabs.dev` route, `config.production.yaml` (Slack user id, Access service token, container app + DO namespace ids), the auto-approve workflow's bot ids |
| Docs | VitePress site, Diataxis, generated reference tables from the command registry (a real strength), 15.7 k words, **behind Cloudflare Access SSO**, 3 screenshots, no landing page, no video; README 40 KB + AGENTS.md 59 KB (ops runbooks, 1Password paths, Polylane discipline) |
| Composability today | memory, run history, MCP, costs, schedules, residents, sandbox are all opt-in config blocks with fallbacks. But the product does not adapt: `help` lists `repo.*` when no resident exists, the dashboard nav shows Residents/Costs regardless, the self-description prose hardcodes residents and the cap of 6, `deploy all` hardcodes four Workers and one account, the dashboard requires Cloudflare Access |
| Third party | vendored skills from `addyosmani/agent-skills` (MIT, needs attribution); Nuxt UI v4, diff2html (MIT) |
| Org precedent | `polylane-k8s` and `skills` are public under MIT; `polylane-k8s` already uses release-please, `SECURITY.md`, `DEVELOPMENT.md` |

## The bar (what "high quality, maintainable OSS" means here)

Drawn from [opensource.guide](https://opensource.guide/starting-a-project/), the [OpenSSF Scorecard checks](https://github.com/ossf/scorecard/blob/main/docs/checks.md), the [Contributor Covenant](https://www.contributor-covenant.org/), [Diataxis](https://diataxis.fr), [ADRs](https://adr.github.io/), [release-please](https://github.com/googleapis/release-please), and how the best small infra projects present themselves:

1. **Understood in 60 seconds.** One-sentence pitch, one diagram, one 30-second GIF, one "what you need" table, one copy-paste quick start. Nothing else above the fold.
2. **Runs in 10 minutes, and nothing you do is a one-way door.** This is a product people *install*, not a repository they fork (Justin, 2026-09-07): one command (`npx switchboard init`) asks for the account, the domain and the Slack app, writes the config and the deployment profile, and deploys to their Cloudflare account — the one supported target (2026-09-08; docker compose is the local development loop, not a deployment). Time-to-value is a design tentpole: every step is one command with a default, and every choice is reversible — config is a readable file, generated deploy files are regenerated not edited, execution backends and optional subsystems switch on and off in config, data (runs, memory) is exportable. Cloudflare, GitHub App, E2B are optional and say so. Our own production is one installation of the product, run from our infra repo's profile and config with the same commands.
3. **Every comment serves the reader who has only the repo.** No company names, people, incidents, private trackers, plan ids. A comment explains *why the code is this way*; provenance lives in `CHANGELOG.md` and `docs/decisions/`.
4. **Design decisions are written down** as ADRs a newcomer can read in an hour, and the code points at them.
5. **Features compose.** Every optional subsystem has an off-state, and help text, dashboards, prompts, deploy tooling, and docs all reflect it.
5a. **Off-the-shelf patterns, named.** The code is built from the vocabulary a newcomer already has: Ports & Adapters at the boundaries, GoF Strategy/Registry/Composite/Null Object where they fit, Fowler's feature toggles and refactoring catalog, Beck's Simple Design and Tidy First, SOLID (open-closed and interface segregation above all), YAGNI as the reason things are deleted. Each ADR names the pattern it instantiates so the map from code to concept is one lookup, and no bespoke abstraction survives where a named one does the job.
6. **Contribution is safe and predictable.** CONTRIBUTING, CODE_OF_CONDUCT, SECURITY with private reporting, CODEOWNERS, templates, labels, Discussions; CI is the gate; conventional commits + release-please; pinned actions; Dependabot; CodeQL; Scorecard badge.
7. **Deployment config lives outside the repo.** The repo ships examples and templates; our production values live in `coreplanelabs/infrastructure`.
8. **Docs are a product surface**: public, pretty, searchable, with a landing page, architecture diagrams, screenshots, a demo video, and the four Diataxis kinds pruned to what a stranger needs.
9. **The repo demonstrates how we work.** World-class code and a world-class process a visitor can read off the repo: CI runs only the scripts a human or an agent runs locally (nothing lives only in YAML); one `npm run verify` is the whole gate; conventional commits are enforced, not suggested; every generated artifact has a `gen` and a `check`; the toolchain is pinned so the same command gives the same result on every machine; AGENTS.md is an opinionated statement of what agentic development looks like here, drives agents through those scripts, and has its command table generated from `package.json`; the development rules are written in terms of Switchboard's own agents, so the product reviews, implements, and ships its own changes in the open.
10. **Docs cannot drift.** Records are immutable except their status; living specs bind every criterion to a real proof; CI checks the bindings, the coverage of each PR's diff, the record statuses, the links, and the generated regions; the review agent is handed only the specs a PR touches and asked whether the diff contradicts them. The rule is stated org-neutrally in the `documentation` rule of Justin's agent config, with this repo as its reference implementation.

---

## Decisions (D-list)

Taken 2026-09-07 (Justin). The recommendations below are kept for the record; the **Taken** column is what the phases build to.

| # | Taken | Consequence for the phases |
|---|---|---|
| D1 | **Apache-2.0** (first answered MIT, changed the same day) | Explicit patent grant; contributions covered by the license's own §5, so no DCO/CLA is needed for inbound = outbound. `NOTICE` carries the copyright line; `THIRD_PARTY_NOTICES.md` carries the vendored skills' MIT notice. |
| D2 | **Same repo, same name, history rewritten in place before the flip.** The private history was written assuming privacy: commit messages and PR bodies are as internal as the comments. Decisions are codified in ADRs, so the history's explanatory value is captured elsewhere; a v0.1.0 does not need 489 commits of provenance. The repo name `coreplanelabs/switchboard` is kept (2026-09-07). | Phases 1–10 run as reviewed PRs on the existing history. Phase 11 **rewrites history in place** once the tooling from Phase 2 is in: a fresh root commit plus a small number of coherent commits built from the scrubbed tree, force-pushed to `main` with branch protection lifted for the operation, every other branch deleted, and a note in the changelog naming the cut. Issues and PRs stay attached to the repo and become public with it, so the scripted scan + triage of their bodies and comments is in scope; the old history remains reachable only in maintainers' local clones (a private archive fork is taken first). |
| D3 | **Dissolve `features/` into the Diataxis tree.** Not kept as a parallel `specs/` folder. | Behavioral contracts become **reference specs** (`docs/reference/specs/<feature>.md`: precise behavior + criteria + the proving test, scrubbed and tightened); the *why* moves to `docs/explanation/` and ADRs; operator steps embedded in `[agent]` criteria become `docs/how-to/` pages or are dropped. AGENTS.md's same-PR discipline points at the reference specs. `features/` is deleted at the end of Phase 7. **Each reference spec carries frontmatter `title` and `summary`** (the specs index page is generated from them, never hand-maintained); **coverage is derived from the spec's existing `**Code**` / `**Tests**` header paths**, which `specs:check` verifies exist — no separate `covers:` field to rot (decided 2026-09-07 against the alternative). |
| D4 | Public docs domain **TBD** (2026-09-07). | Phase 9 hosts on it once chosen; until then the site builds locally and every link to it goes through the one project-facts source (Phase 2), so the change is one line. |
| D5 | Pluggable `dashboard.auth` (`access` \| `token`), `none` on loopback only. | Phase 5. |
| D6 | **1Password env bootstrap stays** as a generic optional integration (a secrets-manager → agent-environment bridge is useful to any self-hoster); scrubbed of our service names and documented as a how-to. **Auto-approve-LGTM** becomes a documented *template* (a how-to page + an example workflow parameterized on the bot identity), not a live workflow in the public repo. **`docs/plans/`**: each plan becomes a *record* under `docs/decisions/` with `status: implemented` or `superseded` (+ `superseded_by`), its reusable *why* distilled into ADRs and explanation pages — nothing is deleted, because a record's value is that it is never lost (revised 2026-09-07). **`config.production.yaml`** becomes `config/examples/*.yaml` with placeholders (`minimal`, `docker-local`, `cloudflare-full`); our real values move to the infra repo. | Phases 3, 4, 7, 8. |
| D7 | **No DCO/CLA**: Apache-2.0 §5 already places intentional submissions under the license; CONTRIBUTING says so. DCO would add sign-off friction to agent-authored commits for no added coverage. | Phase 1. |
| D8 | Company-stewarded, `GOVERNANCE.md`. | Phase 1. |
| D9 | release-please + conventional commits; GHCR image with provenance + SBOM; `0.x`. | Phases 1, 2, 11. |
| D10 | Keep the name. | — |
| D11 | **Contact address `dev@coreplane.ai`** for conduct and security reports, for now; everything of this kind must be easy to change later (2026-09-07). | Phase 1 uses it. Phase 2 makes it, the repo URL, the docs URL, and the org name a single **project-facts** source with a `check` that fails on a stale copy anywhere in the tree. |
| D12 | **The docs lifecycle is enforced by checks, not discipline** (2026-09-07; the org-neutral statement of it is the `documentation` rule in Justin's agent config, which names this repo as its reference implementation). Two kinds of doc, never mixed: **records** (ADRs, plans, proposals, postmortems) are written once, dated, and immutable except a `status` line from the closed set `proposed \| accepted \| implemented \| superseded` plus `superseded_by`; **living specs** (one per feature) carry behavior, invariants, and criteria, each bound to a named proof. GitHub markdown is weak for specs and proposals get lost forever *unless* the repo makes loss impossible: a record cannot drift because it is never edited, a spec cannot drift because CI checks its bindings, its coverage of the diff, and its agreement with the diff. Agents get one always-loaded index under a hard size budget and load bodies on demand — retrieval quality beats volume. | Phase 2 gains four scripts under `verify` (`specs:check`, `specs:coverage`, `decisions:check`, `agents:check`); Phase 7 gains the diff-gated spec review in the review agent; Phase 8's ADRs carry the status frontmatter and an immutability check; the docs-site dead-link check is confirmed to cover `docs/decisions/` and `docs/reference/specs/`. |
| D13 | **Installed, not forked — minimize time-to-value, no one-way doors** (Justin, 2026-09-07). Switchboard is a product an operator installs on their own accounts and runs without reading the source; forking is not the path. So: one artifact (the published image) with no config baked in; `SWITCHBOARD_CONFIG` as the one runtime contract; a deployment profile plus templated Worker configs the CLI generates and regenerates; `deploy all` materializing config from the operator's chosen source (a path, `github://`, `op://`) as a step of the product, never a workflow in this repository; `npx switchboard init` as the one-command front door. Every choice reversible: config is a readable file, generated files are regenerated not edited, backends and optional subsystems toggle in config, runs and memory are exportable. Our production is one installation, deployed by our release workflow calling the same commands with a profile and config it fetches from `coreplanelabs/infrastructure`. Config as a ConfigDO document is a later product decision, not a Phase 3 change. The 1Password loader stays an optional *source* behind the same seam, with its UAT-only rule kept for the agent-env side. Amended 2026-09-08 (Justin): **Cloudflare is the only supported deploy target** — anything else multiplies the runner, the secrets path and the docs for no user we have; docker compose stays as the local loop. And the config-as-a-document decision is taken now, not later: the bot reads its config from the state Worker's ConfigDO (`state://base`), pushed by `deploy config`; the image carries no config. | Phase 3 rewritten (three PRs); Phase 9's Get started page is built on `init`; Phase 11 publishes the image the installer pulls. |

The original recommendations, for the record:

| # | Decision | Recommendation | Alternatives |
|---|---|---|---|
| **D1** | License | **Apache-2.0** — explicit patent grant matters for a product that runs model-generated commands against customers' repos; standard for company-backed infra | MIT (matches `polylane-k8s`/`skills`); AGPL if we want to deter hosted forks |
| **D2** | Repo strategy | **Flip this repo public in place.** History is clean of secrets (verified), 329 PRs are real provenance, the URL and stars accrue. Issues/PR bodies get a scripted scan + triage first (Phase 8) | Fresh repo with squashed history (loses provenance, avoids issue triage) |
| **D3** | `features/` (the behavioral contract, 152 k words) | **Keep, rename to `specs/`, scrub.** It is the most agent-native thing in the repo and a real differentiator; but strip issue refs, receipts links, KTD ids, dated narratives, and delete `milestone-1-vs-claude-tag.md`. Biggest single line item | Archive to the private infra repo and rely on tests + docs (cheapest; loses the agent-verifiable contract and the AGENTS.md discipline) |
| **D4** | Public docs domain | **A product domain** (e.g. `switchboard.dev` / `switchboarddocs.dev` if available), no Access | `docs.switchboard.coreplane.ai`; keep `coreplanelabs.dev` (company name in every URL) |
| **D5** | Dashboard auth for self-hosters | **Pluggable `dashboard.auth`: `access` (today) or `token` (one operator secret → cookie session, resolves to a configured operator actor); `none` only on loopback** | Access-only (blocks every non-Cloudflare deploy from seeing `/runs`) |
| **D6** | Internal-only pieces | **Move out of the public repo**: `.github/workflows/auto-approve-claude-lgtm.yml` (a bot self-approving PRs is a Scorecard smell and a coreplane process), `deploy/agent-env-bootstrap*` (1Password UAT tooling for our downstream services), `config/config.production.yaml`, `docs/plans/**` | Keep any of them behind a "for maintainers" folder |
| **D7** | Contributor agreement | **DCO** (`Signed-off-by`, enforced by a check) — lightweight, standard for Apache-2.0 projects | CLA (heavier; needs a bot and a legal doc); nothing |
| **D8** | Governance | **Company-stewarded, documented in `GOVERNANCE.md`**: coreplanelabs maintainers decide; contributors → committers by invitation; roadmap in Discussions | Leave implicit |
| **D9** | Release cadence | **release-please + conventional commits, GHCR image with provenance + SBOM on each release, 0.x until the config schema is declared stable** | Publish an npm CLI too (later); go 1.0 at flip |
| **D10** | Name | Keep **Switchboard** (an npm package and several unrelated projects share the word; not fatal for an app) | Rename before the flip (only sensible before public) |

Human-gated steps regardless of the answers: the visibility flip, enabling org settings (secret scanning, Discussions, PVR), the domain, the Slack-thread screenshots/video, and a final read of README + landing + tutorials.

---

## Phases

Ordering rule: delete and reshape before you scrub, scrub before you document, document before you flip. Phases 1, 2, and 3 have no dependencies on each other and run in parallel once the D-list is answered.

### Phase 1 — Community and supply-chain scaffolding (1 PR, small)

- `LICENSE` (D1), `NOTICE` + `THIRD_PARTY_NOTICES.md` (vendored skills, generated by a license checker over every lockfile), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `CONTRIBUTING.md` (setup, the three test passes, spec discipline, conventional commits, DCO, PR template expectations), `SECURITY.md` (private vulnerability reporting, supported versions, the trust model in three sentences), `SUPPORT.md`, `GOVERNANCE.md` (D8), `CODEOWNERS`, `.github/ISSUE_TEMPLATE/` (bug, feature, docs, config forms), `PULL_REQUEST_TEMPLATE.md`.
- `package.json`: `license`, `repository`, `bugs`, `homepage`, `description` rewritten; `private: true` stays (app, not a library).
- Dependabot (npm across the 7 lockfiles, grouped weekly; GitHub Actions; Docker), CodeQL, OpenSSF Scorecard workflow + badge, actions pinned to SHAs, `permissions:` minimal everywhere, DCO check, release-please config + `CHANGELOG.md` seeded from the current state.
- Labels: `area/*` (channels, providers, execution, dashboard, docs), `good first issue`, `help wanted`, `needs-decision`; drop `receipts`, `spec-gap`, `self-improvement` (D6/D3).
- **Acceptance**: GitHub's community-profile checklist is 100 %; Scorecard runs green on the checks we control.

### Phase 2 — Engineering process and toolchain: the repo shows how we work (3–4 PRs, medium)

Added 2026-09-07: the repo doubles as the public demonstration of coreplanelabs' engineering process. Every item below is something a visitor can verify by reading the repo, and something an agent can run with the same result every time.

- **CI runs scripts, never bespoke YAML.** Every job step is `npm run <script>`; the scripts live in `package.json` and run identically locally. `npm run verify` is the entire gate (typecheck, tests, lint, format check, generated-artifact checks, license check, hygiene check) and is what CI, the PR template, CONTRIBUTING, and AGENTS.md all name. `npm run fix` applies every auto-fix.
- **One toolchain, pinned.** npm workspaces over the eight package roots (bot, web, docs, five Workers): one `npm ci`, one lockfile, one Dependabot entry, one cache key. `packageManager` + `engines` + `.nvmrc` pin Node and npm; CI and the Dockerfile read them rather than restating versions. Workers keep their own `vitest.config` (workerd) and `wrangler.jsonc`; the workspace only unifies install and scripts.
- **Formatting and linting, enforced.** Prettier for every file type in the tree (TS, Vue, YAML, JSON, Markdown) and ESLint flat config with `typescript-eslint` type-checked rules and `eslint-plugin-vue`; both run in `verify`, both fixable by `fix`. One formatting commit lands first so later diffs stay readable.
- **Conventional commits, enforced.** PR titles are validated against the Conventional Commits grammar in CI (squash merges use the title, and release-please reads it); `npm run check:commits` validates a branch locally. Squash-only merges, `delete_branch_on_merge`, and the merge queue (`merge_group` trigger in `ci.yml`) are repo settings recorded in `docs/how-to/` so a fork can reproduce them.
- **Every generated artifact has a `gen` and a `check`.** The pattern `docs:gen`/`docs:check` and `skills:sync`/`skills:check` already follow becomes the rule: the AGENTS.md command table, the config reference, the CLI reference, the third-party notices are all generated, and `verify` fails on drift. Nothing an agent needs to know about running the repo is hand-maintained prose.
- **One source of project facts.** Name, repo URL, docs URL, contact email, org name, and the bot identity live in one place (`package.json` fields plus a small `project.json` for what npm has no field for); the community files, the docs site config, the dashboard footer, and the self-description read or are generated from it, and `check:project-facts` fails on a stale copy anywhere in the tree. Changing the docs domain or the contact address is one line and one PR.
- **AGENTS.md as a world-class, opinionated operating contract** (Justin, 2026-09-07: showcase how to work with the codebase and what agentic development looks like). Not a slimmed map but a rewritten document with a point of view: (1) *how we develop* — spec first, failing test, implementation, a PR whose body is a Tour, an agent review in the open, the merge queue, an automated release; (2) the invariants; (3) the map; (4) the generated **Commands** table (script, what it does, when to run it, exit codes; every entry deterministic, non-interactive, free of ambient-environment dependence, failing fast by variable name when a credential is missing); (5) the rules for agents — comments for the stranger, decisions as ADRs, Tidy First, conventional titles, never hand-edit a generated region, tests move with code; (6) **Switchboard develops Switchboard**: the development rules are written in terms of the product's own agents — every PR is reviewed by `agent:review` (the verdict contract and the auto-approve template are the process), issues are implemented by `agent:coding` with the vendored skills as its house style, `agent:ship` runs the coding → review → fix loop, run pages are the audit trail, `friction propose` files the process's own improvement issues. The same file is read by Claude Code, by Switchboard's agents working on this repo, and by a human visitor asking "how do these people work?"
- **CI/CD shape a visitor recognizes.** Fast parallel PR checks with required status; Dependabot minors auto-merged after green; docs preview per PR; release-please → tag → GHCR image with provenance + SBOM (Phase 11) → a deploy workflow template with a staging step and a manually approved production environment; README badges for CI, Scorecard, license, and release.
- **The loop, written down.** `docs/explanation/how-we-work.md`: spec → failing test → implementation → PR with a Tour → Switchboard reviews it in the open → merge queue → release-please → deploy, with the AGENTS.md contract as the agent's half of it.
- **Docs-lifecycle checks under `verify`** (D12; added 2026-09-07). Four scripts, each warn-then-error like the hygiene test: **`specs:check`** parses every reference spec and fails when a `**Code**`/`**Tests**` header path does not exist, when a proof cell `file::describe::it` (with `*` globs) matches no real test title in that file (vitest's test list, or a static parse of `describe`/`it` strings), or when a `[gap]` row links no tracker item — rename a test and the build is red until the spec changes. **`specs:coverage`** diffs the PR against `main`, maps each changed path under `src/`, `web/`, `deploy/` to the specs whose `**Code**`/`**Tests**` headers cover it, prints the touched-spec list as a job output (the review agent's input, Phase 7), and fails on a changed path no spec covers. **`decisions:check`** requires every record under `docs/decisions/` to carry a `status` from the closed set and a resolving `superseded_by` when superseded, and diffs accepted records against `main` so that only their status lines may change. **`agents:check`** holds AGENTS.md under 15 KB and its command table equal to `package.json`. The specs index page is generated from each spec's `title` + `summary` frontmatter under the same `gen`/`check` rule.
- **Acceptance**: `ci.yml` contains no `run:` step other than `npm run …` (a unit test asserts it); `npm run verify` passes locally and is the only thing CI calls; a PR titled outside the grammar fails a required check; the AGENTS.md command table matches `package.json` under `check`; a fresh clone at the pinned Node runs `verify` green with no other setup; deleting a bound test makes `verify` fail naming the spec row; changing a changed source path's behavior with no covering spec fails `specs:coverage`; editing an accepted ADR's body fails `decisions:check`; AGENTS.md over budget fails `agents:check`.

### Phase 3 — The product is installed, not forked: config and deployment identity out of the tree (3 PRs, medium)

Reframed 2026-09-07 (D13). The image is one artifact for everyone and contains no config; how it gets its config is the operator's business, and the operator's tool is the product's own CLI — never a GitHub workflow in this repository. Our production becomes one installation among others.

- **PR 1 — config out of the image** (revised 2026-09-08, Justin: Cloudflare is the only supported target, and the config lives in a Durable Object). The bot's config becomes the `base` document on the state Worker's existing `ConfigDO`, beside the overrides: `deploy config` (and `deploy all`, right before the bot step) reads it from the profile's `configSource`, validates it, and pushes it; the bot Worker's `containerEnv` sets `SWITCHBOARD_CONFIG=state://base` and the bot reads the document at startup with `STATE_WORKER_URL` + `MEMORY_TOKEN`; a file path in `SWITCHBOARD_CONFIG` still reads a file (local dev, `docker-compose.yml`'s mount). The Dockerfile stops copying `config/`, so the image is one artifact for every installation and a config change is a push plus `deploy restart`, never an image build. Baking the config into a thin per-installation image was rejected (every edit an image build and rollout; Docker on the deploying machine); Worker vars were rejected (5 KB per var, the config is 9 KB).
- **PR 2 — the deployment profile and templated Worker configs.** `deploy/profile.json` (gitignored, `.example` checked in): account id, Worker names, hostnames, health and admin URLs, which Workers exist, and `configSource` — a local path by default, `github://owner/repo/path@ref` or `op://Vault/Item/field` for operators who keep config elsewhere. Every `deploy/*/wrangler.jsonc` is generated from a template by the CLI (`deploy init`, then re-run freely: generated, never hand-edited), so the 15 `coreplanelabs` values in them become profile fields. `src/deploy/*` reads the profile: `PRODUCTION_ACCOUNT_ID`, `BOT_HEALTH_URL`, `BOT_ADMIN_RESTART_URL`, `DOCS_BASE_URL` stop being constants. `deploy all` materializes the config from `configSource` into the build context before the image builds — the same step for a laptop and for our release workflow. `deploy/secrets.manifest.json` keeps the *names* (the contract) and loses the vault prose; `secrets put` reads from a directory or from `op://` references in the profile, behind the same source seam.
- **PR 3 — our production on the product's path.** Our profile and `config.production.yaml` move to `coreplanelabs/infrastructure` under a top-level `switchboard/` (beside `terrateam/`, the repo's other non-Terraform app directory; never inside a `cloudflare/<account>/` stack, which Terrateam plans); the release workflow's `coreplane-bot` App token is minted for `switchboard,infrastructure` and serves as `CONFIG_REPO_TOKEN`; `SWITCHBOARD_DEPLOY_PROFILE` accepts the same `github://` form as `configSource`, so the workflow names the profile and `deploy all` fetches both; the rendered `wrangler.jsonc` files leave the tree (generated before each Worker's `verify` and each deploy, from the profile or the example); nothing in the repository names our account, hostnames, or organization. Runtime identity from config, not code: `organization` (memory org scope; prod sets `coreplanelabs` so existing rows keep their key), the ship pipeline's PR author derived from the GitHub App at startup (`GET /app` → `<slug>[bot]` + id), self-description text built from config.
- **Not here, but shaped here**: `npx switchboard init` (Phase 9's quick start) is the interactive front to `deploy init` + a config template; the profile and templates built in PR 2 are what make it a one-day job. Config as a ConfigDO document the bot loads at startup is deferred to a later product decision, once the config schema is declared stable — it is a runtime change, and Phase 3 must not be one.
- **Acceptance**: `grep -r coreplane deploy src config` is empty; `npm run cli -- deploy plan` runs from the example profile; `docker compose up` with a mounted `config.yaml` against the built image answers `ask` (the local loop, not a supported deploy target); a generated `wrangler.jsonc` is byte-identical to today's after the profile is filled with our values (the migration proof); the bot starts from the `base` document and refuses to start without one, naming `deploy config`; our production deploys from CI through `deploy all` with a fetched profile, receipted on the release PR.

### Phase 4 — Delete before you scrub (2–3 PRs, medium, some risk)

Things already scheduled for removal, or internal-only, that are cheaper to delete than to de-imprint:

- **Legacy authz translation** (`translateLegacyConfig`, `permissions.*`, token `scopes`/`channel`) — planned as "U7 step 3"; ship it now so the public repo has one authorization model (`grants`). Docs and `config.example.yaml` follow. 36 non-test call sites.
- **Legacy friction ledger writer** (`FrictionDO` / `WorkerFrictionLedger` / JSONL) — run history is the source now; decommission the dual write and the Worker routes.
- D6 items: auto-approve workflow, agent-env-bootstrap (+ its `env.bootstrap` command, feature file, docs), `docs/plans/**` (after D3/D-list is settled, this plan included), `features/milestone-1-vs-claude-tag.md`.
- `docs/self-improvement-architecture.md` folds into explanation pages.
- **Acceptance**: tests green; `features/` index has no rows for removed behavior; the conformance snapshot is updated deliberately.

### Phase 5 — Composability: the product adapts to what is on (2–3 PRs, medium-large)

Design vocabulary for this phase (the patterns are the spec, not decoration):

- **Feature toggles resolved once** (Fowler, *Feature Toggles*): one `Capabilities` value is computed from config at startup and passed down. No surface reads `config.memory?.enabled` itself; scattered `if (config.x)` checks are the smell this phase removes.
- **Null Object / Special Case** (GoF; Fowler, *Introduce Special Case*) for every off-state: the pattern `NullMemoryStore` already follows becomes the rule (`NullResidentAdmin`, `NullLlmCostSource` exists, `NullScheduleStore`, a no-op MCP source), so callers never branch on presence.
- **Open-closed** (SOLID): adding a capability never edits help, the dashboard nav, the self-description, or the deploy plan. Each iterates the capability set and the registry's `enabledWhen`; the change lands in one place.
- **Strategy** for dashboard auth (`access` | `token`), the same shape as providers and executors, behind one small interface (interface segregation: the verifier, not the whole Access module).
- **Dependency inversion** through `CoreDeps` stays the wiring seam; `index.ts` composes, the core never constructs.

Introduce one **capabilities** value computed once at startup from config (`residents`, `sandbox`, `memory`, `runHistory`, `mcp`, `costs`, `schedules`, `github`, `dashboardAuth`) and thread it to every surface:

- `help` / `<group> help` / MCP tool list / HTTP catalogue hide commands whose capability is off, instead of answering `unavailable` (registry gets an `enabledWhen`).
- Dashboard nav and seeds: Residents, Costs, Scheduled tabs render only when on; the `/runs` page's meta line omits resident facts when off.
- Self-description block: generated from capabilities (no residents → no resident paragraph; cap text from the resident Worker's own status, not a constant).
- Status card notes: "repo not onboarded as a resident" only when residents are configured.
- `deploy plan/all`: iterates the profile's Workers; a deployment with only the bot is a one-step plan.
- Dashboard auth (D5): `dashboard.auth: access | token`; `none` refuses to bind off loopback.
- Docs: a **"Turn features on and off"** matrix page — capability, config block, what appears/disappears, what it costs.
- **Acceptance**: a new unit suite runs the whole surface (help text, catalogue, dashboard seeds, self-description, deploy plan) under `minimal` (Slack + one provider), `local-full`, and `cloud-full` capability fixtures and snapshots each; the conformance suite gains a capability axis.

### Phase 6 — Simplify to off-the-shelf shapes (3–5 PRs, medium, behavior-preserving)

Method: Beck's **Tidy First** — every PR in this phase is a tidying, never a behavior change, so the diff is reviewable by structure alone; a behavior change that turns out to be needed gets its own PR before or after. Each move is named with its entry in Fowler's refactoring catalog in the commit message (*Extract Function*, *Move Function*, *Rename*, *Replace Conditional with Polymorphism*, *Introduce Special Case*, *Remove Dead Code*), and the acceptance test is Beck's four rules of Simple Design: passes the tests, reveals intention, no duplication, fewest elements.

- Split `src/core/dispatcher.ts` (2,463 lines, 44 top-level symbols) into the pipeline it already is (a **Pipeline / Chain of Responsibility** of stages): `admission` → `resolve` → `authorize` → `provision` → `run` → `reply` → `record`, each a file with one exported function and its tests moved alongside. No behavior change; the existing 3,554 tests are the harness. `CoreDeps` is split per stage (**interface segregation**): a stage declares the two or three dependencies it uses, not the whole bag.
- Same treatment for `config.ts` (1,028) and `slack.ts` (990) where a seam is obvious.
- Naming pass against the git-hygiene rule ("names tell the truth"): rename things named after their history (`legacy*`, `*Worker` when it is a store, `frictionLedger` vs run history).
- **YAGNI** audit: anything with one implementation and no second caller in sight loses its abstraction (the reverse of invariant 2, which asks for ≥2 implementations before a seam exists). Replace bespoke helpers with the standard library or an existing dependency where one is already present (e.g. `mapLimit` stays — it is 30 lines and tested; a hand-rolled JWT verifier would not).
- **Acceptance**: `npm test` and the conformance snapshot unchanged except for file moves; no file over ~800 lines in `src/core/`; every commit message names its refactoring.

### Phase 7 — De-imprint, and make it impossible to regress (parallel by directory, large)

Policy for every comment, docstring, fixture, and prose line in the public tree:

1. No company, product, or person names other than integrations the code talks to (Slack, GitHub, Anthropic, OpenAI, Cloudflare, E2B, Brave). Forbidden: `coreplane*`, `nominal` (the repo), `polylane`, `terrateam`, `justin`, `Claude Tag`, `#switchboard-prompting`, 1Password vault paths, Slack/Cloudflare ids.
2. No private trackers: no `#NNN`, no `github.com/coreplanelabs/...`, no project-board links in `src/`, `deploy/`, `web/`, `scripts/`, `config/`, `docs/` (the reference specs included). Provenance goes to `CHANGELOG.md` and ADRs (Phase 8), which may cite PRs.
3. No plan ids (`KTD…`, `KD…`, `OQ…`, `R1…`, `U…`) and no dated incident narratives. Rewrite each as the timeless rule it encodes ("a re-review must fetch the PR head, because the worktree can lag the remote") or delete it.
4. Test fixtures use `acme/api`-style names; `src/core/authz/testing.ts`'s `REPOS` and friends change accordingly.

Mechanics: one worktree per directory (`src/core`, `src/channels+execution+mcp`, `src/rest`, `deploy`, `web`, `features`→`docs/reference/specs`, `docs`), each a PR; a shared `docs/decisions/` index (Phase 8) so scrubbers can point at an ADR instead of an issue. **`scripts/public-hygiene.test.ts`** encodes the policy as regexes with a per-line allowlist file and runs in CI from the first PR (warn) and fails from the last (error). The word "nominal" as English (backoff) is allowlisted by line.

- **Diff-gated spec review** (D12; added 2026-09-07) — the piece that catches drift, and Switchboard reviewing its own specs: the review agent's prompt receives the touched-spec list `specs:coverage` emitted for the PR and, for each covered spec, asks whether the diff contradicts any behavior statement or criterion. A contradiction is a finding at minor or above; the spec is fixed in the PR or the review does not LGTM. Only the touched specs are loaded, never the whole tree — that is what keeps the agent's context small and its judgement sharp. Lands as a prompt block in the review agent plus a criterion in the agent-review reference spec, once the specs have their Phase 7 shape.
- **Acceptance**: the hygiene test passes in error mode over the whole tracked tree; a reviewer opening any file at random finds every comment answerable from the repo alone; a PR that changes a covered behavior without updating its spec receives a spec-contradiction finding from the review agent (proven on a deliberate test PR).

### Phase 8 — Design decisions as ADRs (1 PR, medium)

- `docs/decisions/` with ~20 ADRs distilled from the four plans, AGENTS.md, and the KTD/KD ids that comments lean on today: seams with ≥2 implementations; dispatcher as the only orchestrator; outbound-only Slack (Socket Mode) and what it costs; platform-namespaced ids; layered config and effort as a first-class dimension; runs have two lives (live registry, then history); one command definition → every surface; authorization as a policy table over a closed condition vocabulary; residents as a second credential domain; typed LLM output; thread admission; reconnect catch-up as recovery; capability tokens for live run pages; why the dashboard is CSP `script-src 'self'`; deploy order and "deployed ≠ live"; why not serverless-native; why memory is off by default.
- Records are immutable (D12): every ADR carries frontmatter `status` (`proposed | accepted | implemented | superseded`), `date`, and `superseded_by` when superseded; after acceptance only the status lines may change, and `decisions:check` (Phase 2) diffs accepted records against `main` to hold that line. The four dated plans under `docs/plans/` become records here with `status: implemented` or `superseded`, so no proposal is ever lost. Each ADR: context, decision, consequences, alternatives rejected, status, and **the named pattern it instantiates** (Ports & Adapters for the seams; Strategy for providers/executors/auth; Registry for agents, commands, schedules; Composite for tool sources; Null Object for off-states; Fowler's feature toggles for capabilities; capability-based security for live-run tokens; a rules table for authorization) so a newcomer maps code to a concept they already know in one lookup. An index page in the docs site under **Explanation → Design decisions**.
- Comments that need provenance say `see docs/decisions/0007-authorization-policy-table.md`.
- `AGENTS.md` takes its Phase 2 shape (the opinionated contract, ≈ 15 KB, command table generated): the ops runbook content it carries today moves to `docs/operations/` (generic) and the infra repo (ours), and the map's row-per-file detail moves into the ADRs and reference specs it points at, so the file reads as a manifesto with pointers, not an index.

### Phase 9 — README, docs site, landing page (3–4 PRs, large)

**README (≤ 200 lines)**: the pitch in one sentence; a 30-second GIF (Slack mention → status card → PR link); the four-seam diagram; **What you need** table (required: Slack app, one model key; optional: GitHub App, Cloudflare account, E2B, Brave, with what each unlocks); **Quick start** (three commands with the published image); links: docs, architecture, contributing, security, license. Everything else moves to the site.

**Docs site** (stay on VitePress: Vue-native, mermaid works, the team knows Vue; a custom home layout gives us everything Starlight would):

- Home: hero with a custom **animated request-flow** (message → dispatcher → agent → executor → PR, SVG + CSS, reduced-motion aware), the one-sentence pitch, three CTAs (Try in 60 s / Deploy / Read the design); feature grid of the four seams; a screenshot strip (Slack thread, run page, residents); the demo video; footer with license + Discussions.
- Theme: a deliberate palette and type pairing (not the VitePress defaults), dark mode, consistent diagram styling for mermaid.
- Public hosting on the D4 domain; the docs Worker loses Access; CI deploy stays.
- New pages: **Get started** (`npx switchboard init` → a running `ask` → Slack → production, each one command; the D13 tentpole), **Set up accounts** (Slack via a checked-in `slack-app-manifest.yaml`, model keys, GitHub App step-by-step, Cloudflare optional with what it buys, E2B optional), **Turn features on and off** (Phase 5), **How we work** (Phase 2), **Deploy** (Cloudflare, the one supported target — profile, `deploy init`, `deploy secrets`, `deploy config`, `deploy all`; docker compose is the local loop only), **Security model**, **Architecture** (the diagrams from README, redrawn to one style), **Design decisions** (ADR index), **Contributing**.
- Every existing page rewritten in Diataxis voice with the 17 internal references removed; reference tables stay generated from the registry (`docs:gen`).
- **Acceptance**: dead-link build green; Lighthouse ≥ 95 on home; a first-time reader reaches a running `ask` from the home page in ≤ 3 clicks; human read of README + home + Get started (Justin).

### Phase 10 — Visuals and demo (1 PR + human-gated captures)

- Dashboard screenshots from `scripts/web-preview.ts` fixtures (deterministic, no real data), both themes.
- Slack thread screenshots and the 30-second GIF/MP4 need a real workspace: a script of the three moments to capture (mention → 👀 + status card → PR link; `config set channel`; `repo list`) for Justin or a fresh workspace with fixture data.
- Architecture diagrams: one visual system across README, site, and ADRs (mermaid theme tokens shared by the site theme).

### Phase 11 — Release pipeline, history rewrite, and go-public (2 PRs + human-gated flip)

- Release workflow: release-please PR → tag → GHCR image `ghcr.io/coreplanelabs/switchboard:<version>` with build provenance attestation and SBOM; the image is the base the bot Worker's container build starts from (and what docker compose runs locally), not a second deploy target.
- **History rewrite in place (D2)**, scripted and rehearsed on a throwaway fork first: take a private archive fork of the repo as-is; build the new history from the scrubbed tree as a fresh root commit plus a handful of coherent commits (one per area, conventional titles); lift branch protection, force-push `main`, delete every other branch and tag, re-point release-please's `bootstrap-sha` at the new root, restore protection; run the Phase 7 hygiene test over `git log -p` of the new history so no old message survives. The archive fork is where the pre-rewrite history lives from then on.
- Scripted scan of every issue and PR body/comment for the Phase 7 forbidden list plus Slack ids, account ids, vault paths; a triage list for Justin (edit, close, or leave). Close stale issues; move the receipts process out (D3).
- Repo settings: Discussions on, wiki off, secret scanning + push protection on, private vulnerability reporting on, Dependabot alerts on, branch protection on `main` (PR + 1 CODEOWNERS review + CI + linear history + no force push; `codeql`/`analyze` becomes a required check only now, once the repo is public and the job actually runs), squash-only merges, delete branch on merge, `homepage` = docs URL, topics.
- Flip to public; cut `v0.1.0`; announce (Discussions post, the release notes).
- **Acceptance**: Scorecard ≥ 8; community profile 100 %; a clean clone follows README to a running `ask` without asking anyone.

---

## Parallelism and sequencing

```
D-list ──► Phase 1 ─┐
       ├─► Phase 2 ─┤
       └─► Phase 3 ─┤
                    ├─► Phase 4 ─► Phase 5 ─► Phase 6 ─► Phase 7 (7 parallel worktrees) ─► Phase 8 ─► Phase 9 ─► Phase 10 ─► Phase 11
                    │                                          ▲
                    └── Phase 8 ADR drafts can start here ─────┘
```

Rough size, agent-days: P1 0.5 · P2 2.5 · P3 1 · P4 1.5 · P5 2.5 · P6 2 · P7 4 (parallel, ~1.5 wall) · P8 1 · P9 3 · P10 0.5 + human · P11 1 + human. About two and a half weeks of wall clock with the parallel scrub, dominated by P7 (`features/`), P9, and P2's workspace unification.

## Risks

- **`features/` scrub scale** (D3): 152 k words. Mitigation: parallel worktrees, the hygiene test as the definition of done, and the fallback of archiving files whose criteria are all `[agent]` receipts.
- **Workspace unification (Phase 2)**: hoisting can change what the Workers' `vitest-pool-workers` and wrangler resolve, and the Dockerfile's two-stage install assumes separate lockfiles. Mitigation: convert one package root at a time behind the existing CI jobs; keep per-Worker `vitest.config` and `wrangler.jsonc`; the Docker build is part of `verify` (a `docker build --target build` smoke) before the switch lands.
- **Behavior drift during Phase 6**: the dispatcher split is the riskiest edit. Mitigation: file moves only, tests move with code, conformance snapshot unchanged, one PR per extracted stage.
- **Prod continuity during Phases 3 and 5**: memory org key, PR-author identity, config path, dashboard auth all change shape. Mitigation: prod profile in the infra repo mirrors today's values; deploy through `deploy all` with the live gate; receipts on the tracker before the next phase.
- **Public issues/PRs** (D2): 464 items of internal chatter become public. Mitigation: the scripted scan in Phase 11 and a triage pass; nothing secret is known to be there.
- **Docs domain and Access removal**: the dashboards stay behind Access; only the docs Worker opens up. No product surface becomes public.

## Validation summary

| Criterion | Proof |
|---|---|
| No forbidden tokens anywhere in the tracked tree | `scripts/public-hygiene.test.ts` in error mode, in CI |
| Every optional subsystem has an off-state the surfaces reflect | capability-fixture snapshot suite (Phase 5) |
| One authorization model, no translation layer | `src/core/authz/*.test.ts`; `config.example.yaml` has no `permissions` block |
| Deploy tooling runs from a profile, not constants | `src/deploy/plan.test.ts` over the example profile |
| Docs build with no dead links; reference tables match the registry | `npm run docs:check`, `npm --prefix docs run build` in CI |
| CI calls only `npm run` scripts; `verify` is the whole gate; PR titles are conventional | a unit test over `ci.yml`; the required title check on every PR |
| Every spec proof reference resolves; every changed source path has a covering spec | `specs:check` and `specs:coverage` under `verify`; negative: delete a bound test, verify names the spec row |
| Records are immutable except status; every status is valid and every `superseded_by` resolves | `decisions:check` under `verify`; negative: edit an accepted ADR body |
| The agent index stays under budget | `agents:check` under `verify` |
| A PR that contradicts a covered spec gets a review finding | the review agent's spec-contradiction block, proven on a deliberate test PR |
| The AGENTS.md command table matches `package.json` | its `check` script, in `verify` |
| Community profile complete; Scorecard green on controllable checks | GitHub community tab; Scorecard action badge |
| A stranger runs `ask` from a clean clone | Get-started page followed in a fresh container in CI (`docs-smoke` job) |
| README, home page, tutorials read as human-edited | Justin's read (human-gated) |
| Slack screenshots + demo video present | Justin's capture (human-gated) |
