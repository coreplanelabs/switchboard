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
2. **Runs in 10 minutes.** A Slack app manifest (one click), a `.env`, `docker compose up` against a published image. Cloudflare, GitHub App, E2B are optional and say so.
3. **Every comment serves the reader who has only the repo.** No company names, people, incidents, private trackers, plan ids. A comment explains *why the code is this way*; provenance lives in `CHANGELOG.md` and `docs/decisions/`.
4. **Design decisions are written down** as ADRs a newcomer can read in an hour, and the code points at them.
5. **Features compose.** Every optional subsystem has an off-state, and help text, dashboards, prompts, deploy tooling, and docs all reflect it.
5a. **Off-the-shelf patterns, named.** The code is built from the vocabulary a newcomer already has: Ports & Adapters at the boundaries, GoF Strategy/Registry/Composite/Null Object where they fit, Fowler's feature toggles and refactoring catalog, Beck's Simple Design and Tidy First, SOLID (open-closed and interface segregation above all), YAGNI as the reason things are deleted. Each ADR names the pattern it instantiates so the map from code to concept is one lookup, and no bespoke abstraction survives where a named one does the job.
6. **Contribution is safe and predictable.** CONTRIBUTING, CODE_OF_CONDUCT, SECURITY with private reporting, CODEOWNERS, templates, labels, Discussions; CI is the gate; conventional commits + release-please; pinned actions; Dependabot; CodeQL; Scorecard badge.
7. **Deployment config lives outside the repo.** The repo ships examples and templates; our production values live in `coreplanelabs/infrastructure`.
8. **Docs are a product surface**: public, pretty, searchable, with a landing page, architecture diagrams, screenshots, a demo video, and the four Diataxis kinds pruned to what a stranger needs.

---

## Decisions (D-list)

Taken 2026-09-07 (Justin). The recommendations below are kept for the record; the **Taken** column is what the phases build to.

| # | Taken | Consequence for the phases |
|---|---|---|
| D1 | **Apache-2.0** (first answered MIT, changed the same day) | Explicit patent grant; contributions covered by the license's own §5, so no DCO/CLA is needed for inbound = outbound. `NOTICE` carries the copyright line; `THIRD_PARTY_NOTICES.md` carries the vendored skills' MIT notice. |
| D2 | **Fresh public repo, curated history.** The private repo was written assuming privacy: commit messages and PR bodies are as internal as the comments, and 464 issues/PRs would need triage. Decisions are codified in ADRs, so the history's explanatory value is captured elsewhere; a v0.1.0 does not need 489 commits of provenance. | Phases 1–9 still run as reviewed PRs in the private repo. Phase 10 becomes an **export**: the scrubbed tree lands in a new `coreplanelabs/switchboard` (the private repo is renamed to `switchboard-private` first, or the public one takes a new name) with a small number of coherent commits, then settings, then v0.1.0. Open issues that belong to the public roadmap are re-filed cleanly. |
| D3 | **Dissolve `features/` into the Diataxis tree.** Not kept as a parallel `specs/` folder. | Behavioral contracts become **reference specs** (`docs/reference/specs/<feature>.md`: precise behavior + criteria + the proving test, scrubbed and tightened); the *why* moves to `docs/explanation/` and ADRs; operator steps embedded in `[agent]` criteria become `docs/how-to/` pages or are dropped. AGENTS.md's same-PR discipline points at the reference specs. `features/` is deleted at the end of Phase 6. |
| D4 | Product domain, **Justin to choose**. | Phase 8 hosts on it; until then the site builds locally. |
| D5 | Pluggable `dashboard.auth` (`access` \| `token`), `none` on loopback only. | Phase 4. |
| D6 | **1Password env bootstrap stays** as a generic optional integration (a secrets-manager → agent-environment bridge is useful to any self-hoster); scrubbed of our service names and documented as a how-to. **Auto-approve-LGTM** becomes a documented *template* (a how-to page + an example workflow parameterized on the bot identity), not a live workflow in the public repo. **`docs/plans/`** dissolves into ADRs + explanation, then is deleted. **`config.production.yaml`** becomes `config/examples/*.yaml` with placeholders (`minimal`, `docker-local`, `cloudflare-full`); our real values move to the infra repo. | Phases 2, 3, 6, 7. |
| D7 | **No DCO/CLA**: Apache-2.0 §5 already places intentional submissions under the license; CONTRIBUTING says so. DCO would add sign-off friction to agent-authored commits for no added coverage. | Phase 1. |
| D8 | Company-stewarded, `GOVERNANCE.md`. | Phase 1. |
| D9 | release-please + conventional commits; GHCR image with provenance + SBOM; `0.x`. | Phases 1, 10. |
| D10 | Keep the name. | — |

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

Ordering rule: delete and reshape before you scrub, scrub before you document, document before you flip. Phases 1 and 3 have no dependencies and run in parallel with the D-list.

### Phase 1 — Community and supply-chain scaffolding (1 PR, small)

- `LICENSE` (D1), `NOTICE` + `THIRD_PARTY_NOTICES.md` (vendored skills, generated by a license checker over every lockfile), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `CONTRIBUTING.md` (setup, the three test passes, spec discipline, conventional commits, DCO, PR template expectations), `SECURITY.md` (private vulnerability reporting, supported versions, the trust model in three sentences), `SUPPORT.md`, `GOVERNANCE.md` (D8), `CODEOWNERS`, `.github/ISSUE_TEMPLATE/` (bug, feature, docs, config forms), `PULL_REQUEST_TEMPLATE.md`.
- `package.json`: `license`, `repository`, `bugs`, `homepage`, `description` rewritten; `private: true` stays (app, not a library).
- Dependabot (npm across the 7 lockfiles, grouped weekly; GitHub Actions; Docker), CodeQL, OpenSSF Scorecard workflow + badge, actions pinned to SHAs, `permissions:` minimal everywhere, DCO check, release-please config + `CHANGELOG.md` seeded from the current state.
- Labels: `area/*` (channels, providers, execution, dashboard, docs), `good first issue`, `help wanted`, `needs-decision`; drop `receipts`, `spec-gap`, `self-improvement` (D6/D3).
- **Acceptance**: GitHub's community-profile checklist is 100 %; Scorecard runs green on the checks we control.

### Phase 2 — Deployment config out of the repo (1–2 PRs, medium)

- `config/config.production.yaml` moves to `coreplanelabs/infrastructure`; the image reads config from a mounted/env path; `config.example.yaml` becomes the only config in the repo and every block documents its off-state.
- `deploy/*/wrangler.jsonc`: no `account_id`, no `coreplanelabs.dev` routes; per-environment values via `env.<name>` blocks or a gitignored `wrangler.<env>.jsonc` overlay with a checked-in `.example`; `CLOUDFLARE_ACCOUNT_ID` from the environment.
- `src/deploy/*`: the deploy CLI reads a **deployment profile** (`deploy/profile.json`, gitignored, `.example` checked in): account, worker names, health URLs, which Workers exist. `PRODUCTION_ACCOUNT_ID`, `BOT_HEALTH_URL`, `BOT_ADMIN_RESTART_URL`, `DOCS_BASE_URL` stop being constants.
- Runtime identity from config, not code: `organization` (memory org scope; prod sets `coreplanelabs` so existing rows keep their key), the ship pipeline's PR author derived from the GitHub App at startup (`GET /app` → `<slug>[bot]` + id), `SWITCHBOARD_REPO`/self-description text built from config.
- `deploy/secrets.manifest.json` keeps the *names* (they are the contract) but loses the 1Password/vault prose; `put-secrets.mjs` reads from a configurable directory.
- **Acceptance**: `grep -r coreplane deploy src config` is empty; `npm run cli -- deploy plan` runs from the example profile; `src/config.production.test.ts` moves with the config to the infra repo (or becomes a golden over the example).

### Phase 3 — Delete before you scrub (2–3 PRs, medium, some risk)

Things already scheduled for removal, or internal-only, that are cheaper to delete than to de-imprint:

- **Legacy authz translation** (`translateLegacyConfig`, `permissions.*`, token `scopes`/`channel`) — planned as "U7 step 3"; ship it now so the public repo has one authorization model (`grants`). Docs and `config.example.yaml` follow. 36 non-test call sites.
- **Legacy friction ledger writer** (`FrictionDO` / `WorkerFrictionLedger` / JSONL) — run history is the source now; decommission the dual write and the Worker routes.
- D6 items: auto-approve workflow, agent-env-bootstrap (+ its `env.bootstrap` command, feature file, docs), `docs/plans/**` (after D3/D-list is settled, this plan included), `features/milestone-1-vs-claude-tag.md`.
- `docs/self-improvement-architecture.md` folds into explanation pages.
- **Acceptance**: tests green; `features/` index has no rows for removed behavior; the conformance snapshot is updated deliberately.

### Phase 4 — Composability: the product adapts to what is on (2–3 PRs, medium-large)

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

### Phase 5 — Simplify to off-the-shelf shapes (3–5 PRs, medium, behavior-preserving)

Method: Beck's **Tidy First** — every PR in this phase is a tidying, never a behavior change, so the diff is reviewable by structure alone; a behavior change that turns out to be needed gets its own PR before or after. Each move is named with its entry in Fowler's refactoring catalog in the commit message (*Extract Function*, *Move Function*, *Rename*, *Replace Conditional with Polymorphism*, *Introduce Special Case*, *Remove Dead Code*), and the acceptance test is Beck's four rules of Simple Design: passes the tests, reveals intention, no duplication, fewest elements.

- Split `src/core/dispatcher.ts` (2,463 lines, 44 top-level symbols) into the pipeline it already is (a **Pipeline / Chain of Responsibility** of stages): `admission` → `resolve` → `authorize` → `provision` → `run` → `reply` → `record`, each a file with one exported function and its tests moved alongside. No behavior change; the existing 3,554 tests are the harness. `CoreDeps` is split per stage (**interface segregation**): a stage declares the two or three dependencies it uses, not the whole bag.
- Same treatment for `config.ts` (1,028) and `slack.ts` (990) where a seam is obvious.
- Naming pass against the git-hygiene rule ("names tell the truth"): rename things named after their history (`legacy*`, `*Worker` when it is a store, `frictionLedger` vs run history).
- **YAGNI** audit: anything with one implementation and no second caller in sight loses its abstraction (the reverse of invariant 2, which asks for ≥2 implementations before a seam exists). Replace bespoke helpers with the standard library or an existing dependency where one is already present (e.g. `mapLimit` stays — it is 30 lines and tested; a hand-rolled JWT verifier would not).
- **Acceptance**: `npm test` and the conformance snapshot unchanged except for file moves; no file over ~800 lines in `src/core/`; every commit message names its refactoring.

### Phase 6 — De-imprint, and make it impossible to regress (parallel by directory, large)

Policy for every comment, docstring, fixture, and prose line in the public tree:

1. No company, product, or person names other than integrations the code talks to (Slack, GitHub, Anthropic, OpenAI, Cloudflare, E2B, Brave). Forbidden: `coreplane*`, `nominal` (the repo), `polylane`, `terrateam`, `justin`, `Claude Tag`, `#switchboard-prompting`, 1Password vault paths, Slack/Cloudflare ids.
2. No private trackers: no `#NNN`, no `github.com/coreplanelabs/...`, no project-board links in `src/`, `deploy/`, `web/`, `scripts/`, `config/`, `specs/`, `docs/`. Provenance goes to `CHANGELOG.md` and ADRs (Phase 7), which may cite PRs.
3. No plan ids (`KTD…`, `KD…`, `OQ…`, `R1…`, `U…`) and no dated incident narratives. Rewrite each as the timeless rule it encodes ("a re-review must fetch the PR head, because the worktree can lag the remote") or delete it.
4. Test fixtures use `acme/api`-style names; `src/core/authz/testing.ts`'s `REPOS` and friends change accordingly.

Mechanics: one worktree per directory (`src/core`, `src/channels+execution+mcp`, `src/rest`, `deploy`, `web`, `specs`, `docs`), each a PR; a shared `docs/decisions/` index (Phase 7) so scrubbers can point at an ADR instead of an issue. **`scripts/public-hygiene.test.ts`** encodes the policy as regexes with a per-line allowlist file and runs in CI from the first PR (warn) and fails from the last (error). The word "nominal" as English (backoff) is allowlisted by line.

- **Acceptance**: the hygiene test passes in error mode over the whole tracked tree; a reviewer opening any file at random finds every comment answerable from the repo alone.

### Phase 7 — Design decisions as ADRs (1 PR, medium)

- `docs/decisions/` with ~20 ADRs distilled from the four plans, AGENTS.md, and the KTD/KD ids that comments lean on today: seams with ≥2 implementations; dispatcher as the only orchestrator; outbound-only Slack (Socket Mode) and what it costs; platform-namespaced ids; layered config and effort as a first-class dimension; runs have two lives (live registry, then history); one command definition → every surface; authorization as a policy table over a closed condition vocabulary; residents as a second credential domain; typed LLM output; thread admission; reconnect catch-up as recovery; capability tokens for live run pages; why the dashboard is CSP `script-src 'self'`; deploy order and "deployed ≠ live"; why not serverless-native; why memory is off by default.
- Each ADR: context, decision, consequences, alternatives rejected, status, and **the named pattern it instantiates** (Ports & Adapters for the seams; Strategy for providers/executors/auth; Registry for agents, commands, schedules; Composite for tool sources; Null Object for off-states; Fowler's feature toggles for capabilities; capability-based security for live-run tokens; a rules table for authorization) so a newcomer maps code to a concept they already know in one lookup. An index page in the docs site under **Explanation → Design decisions**.
- Comments that need provenance say `see docs/decisions/0007-authorization-policy-table.md`.
- `AGENTS.md` shrinks to invariants + map + how to verify (target ≤ 12 KB); the ops runbook content moves to `docs/operations/` (generic) and the infra repo (ours).

### Phase 8 — README, docs site, landing page (3–4 PRs, large)

**README (≤ 200 lines)**: the pitch in one sentence; a 30-second GIF (Slack mention → status card → PR link); the four-seam diagram; **What you need** table (required: Slack app, one model key; optional: GitHub App, Cloudflare account, E2B, Brave, with what each unlocks); **Quick start** (three commands with the published image); links: docs, architecture, contributing, security, license. Everything else moves to the site.

**Docs site** (stay on VitePress: Vue-native, mermaid works, the team knows Vue; a custom home layout gives us everything Starlight would):

- Home: hero with a custom **animated request-flow** (message → dispatcher → agent → executor → PR, SVG + CSS, reduced-motion aware), the one-sentence pitch, three CTAs (Try in 60 s / Deploy / Read the design); feature grid of the four seams; a screenshot strip (Slack thread, run page, residents); the demo video; footer with license + Discussions.
- Theme: a deliberate palette and type pairing (not the VitePress defaults), dark mode, consistent diagram styling for mermaid.
- Public hosting on the D4 domain; the docs Worker loses Access; CI deploy stays.
- New pages: **Get started** (CLI-only in 2 minutes → Slack locally → production), **Set up accounts** (Slack via a checked-in `slack-app-manifest.yaml`, model keys, GitHub App step-by-step, Cloudflare optional with what it buys, E2B optional), **Turn features on and off** (Phase 4), **Deploy** (docker compose with the GHCR image / Fly / Cloudflare), **Security model**, **Architecture** (the diagrams from README, redrawn to one style), **Design decisions** (ADR index), **Contributing**.
- Every existing page rewritten in Diataxis voice with the 17 internal references removed; reference tables stay generated from the registry (`docs:gen`).
- **Acceptance**: dead-link build green; Lighthouse ≥ 95 on home; a first-time reader reaches a running `ask` from the home page in ≤ 3 clicks; human read of README + home + Get started (Justin).

### Phase 9 — Visuals and demo (1 PR + human-gated captures)

- Dashboard screenshots from `scripts/web-preview.ts` fixtures (deterministic, no real data), both themes.
- Slack thread screenshots and the 30-second GIF/MP4 need a real workspace: a script of the three moments to capture (mention → 👀 + status card → PR link; `config set channel`; `repo list`) for Justin or a fresh workspace with fixture data.
- Architecture diagrams: one visual system across README, site, and ADRs (mermaid theme tokens shared by the site theme).

### Phase 10 — Release pipeline and go-public (2 PRs + human-gated flip)

- Release workflow: release-please PR → tag → GHCR image `ghcr.io/coreplanelabs/switchboard:<version>` with build provenance attestation and SBOM; docker-compose and the docs pin the image.
- Scripted scan of every issue and PR body/comment for the Phase 6 forbidden list plus Slack ids, account ids, vault paths; a triage list for Justin (edit, close, or leave). Close stale issues; move the receipts process out (D3).
- Repo settings: Discussions on, wiki off, secret scanning + push protection on, private vulnerability reporting on, Dependabot alerts on, branch protection on `main` (PR + 1 CODEOWNERS review + CI + linear history + no force push), squash-only merges, delete branch on merge, `homepage` = docs URL, topics.
- Flip to public; cut `v0.1.0`; announce (Discussions post, the release notes).
- **Acceptance**: Scorecard ≥ 8; community profile 100 %; a clean clone follows README to a running `ask` without asking anyone.

---

## Parallelism and sequencing

```
D-list ──► Phase 1 ─┐
       └─► Phase 2 ─┤
                    ├─► Phase 3 ─► Phase 4 ─► Phase 5 ─► Phase 6 (7 parallel worktrees) ─► Phase 7 ─► Phase 8 ─► Phase 9 ─► Phase 10
                    │                                          ▲
                    └── Phase 7 ADR drafts can start here ─────┘
```

Rough size, agent-days: P1 0.5 · P2 1 · P3 1.5 · P4 2.5 · P5 2 · P6 4 (parallel, ~1.5 wall) · P7 1 · P8 3 · P9 0.5 + human · P10 1 + human. About two weeks of wall clock with the parallel scrub, dominated by P6 (`features/`) and P8.

## Risks

- **`features/` scrub scale** (D3): 152 k words. Mitigation: parallel worktrees, the hygiene test as the definition of done, and the fallback of archiving files whose criteria are all `[agent]` receipts.
- **Behavior drift during Phase 5**: the dispatcher split is the riskiest edit. Mitigation: file moves only, tests move with code, conformance snapshot unchanged, one PR per extracted stage.
- **Prod continuity during Phase 2/4**: memory org key, PR-author identity, config path, dashboard auth all change shape. Mitigation: prod profile in the infra repo mirrors today's values; deploy through `deploy all` with the live gate; receipts on the tracker before the next phase.
- **Public issues/PRs** (D2): 464 items of internal chatter become public. Mitigation: the scripted scan in Phase 10 and a triage pass; nothing secret is known to be there.
- **Docs domain and Access removal**: the dashboards stay behind Access; only the docs Worker opens up. No product surface becomes public.

## Validation summary

| Criterion | Proof |
|---|---|
| No forbidden tokens anywhere in the tracked tree | `scripts/public-hygiene.test.ts` in error mode, in CI |
| Every optional subsystem has an off-state the surfaces reflect | capability-fixture snapshot suite (Phase 4) |
| One authorization model, no translation layer | `src/core/authz/*.test.ts`; `config.example.yaml` has no `permissions` block |
| Deploy tooling runs from a profile, not constants | `src/deploy/plan.test.ts` over the example profile |
| Docs build with no dead links; reference tables match the registry | `npm run docs:check`, `npm --prefix docs run build` in CI |
| Community profile complete; Scorecard green on controllable checks | GitHub community tab; Scorecard action badge |
| A stranger runs `ask` from a clean clone | Get-started page followed in a fresh container in CI (`docs-smoke` job) |
| README, home page, tutorials read as human-edited | Justin's read (human-gated) |
| Slack screenshots + demo video present | Justin's capture (human-gated) |
