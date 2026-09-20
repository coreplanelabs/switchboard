---
title: The control plane is where the maintainer works - Plan
type: feat
date: 2026-09-19
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
extends: ../decisions/0070-the-control-plane-is-where-the-maintainer-works-the-plane-page-pins-a-chat-column-beside-the-panels-and-an-orchestrator-thread-answers-about-the-fleet-and-acts-on-it.md
---

# The control plane is where the maintainer works - Plan

## Goal Capsule

- **Objective**: Build [record 0070](../decisions/0070-the-control-plane-is-where-the-maintainer-works-the-plane-page-pins-a-chat-column-beside-the-panels-and-an-orchestrator-thread-answers-about-the-fleet-and-acts-on-it.md): the `/plane` page becomes two columns — the panels beside a pinned chat — and the chat is one long-lived orchestrator thread per person, bound to an `orchestrator` preset that answers fleet questions from the plane's tables and acts through the one fenced door under the person's own grants, with receipts, issues and a resume ledger kept on the thread.
- **Authority**: record 0070 (proposed; this plan is the artifact its acceptance is judged on) over [orchestration-plane.md](../reference/specs/orchestration-plane.md), [web-chat.md](../reference/specs/web-chat.md), [routing-and-config.md](../reference/specs/routing-and-config.md), [command-registry.md](../reference/specs/command-registry.md) and the spec rows each unit names; the decider's conditions, windows and moves stay [record 0064](../decisions/0064-the-plane-owns-every-runs-state-a-refusal-becomes-a-queue-position-an-ending-is-judged-by-the-ledger-that-saw-it-and-a-release-is-a-quiet-window-a-person-closes.md)'s and its plan's.
- **Execution profile**: five code units in this repository, each one pull request through the review loop, tests first in every unit. U1 is the smallest useful slice — the two-column page with the existing web chat pinned to the person's orchestrator thread — and lands in a day; its visual choices are the maintainer's, checked in before the pull request leaves draft. U2 and U3 are the preset's reads and writes; U4 the receipts and the ledger; U5 the economics receipt and the record's acceptance. No new store, no new channel, no change to the operator's binding or the policy table's shape.
- **Stop conditions**: a unit that needs a second chat implementation, a standing service credential, a write the registry does not define, or an admission rule restated in preset prose hands back a deviation before changing anything.
- **Tail ownership**: each pull request merges through the review loop under the freeze's rules in force; the U1 layout and every later screenshot are the maintainer's to approve; the U5 cost receipt is posted on the record before it flips.

---

## Product Contract

### Summary

The plane's tables shipped read-only and the web chat lives on its own page; every orchestration act of a release day runs from a terminal over the MCP tools and `gh`, outside the registry's fences and record. Record 0070 holds the survey, the trace and the argument; this plan holds the units.

### Problem Frame

Three surfaces hold one job: the panels show the fleet, the chat can converse but knows nothing of the fleet, and the terminal holds the authority. The acts that matter most — the merge, the drain, the release handoff — have no registry command at all, so they run unfenced and unrecorded, and the day's working context dies with the terminal window.

### Requirements

**The two-column page (record 0070, "The shape"; U1)**

- R1. `/plane` renders two columns at the wide breakpoint: the existing panels on one side, a pinned chat column on the other; the chat is the existing web chat's composer, turns and cards, bound to the viewer's orchestrator thread — no second chat implementation, no new transport.
- R2. The orchestrator thread is keyed to the person the dashboard session names, one per person, created on first open and continued ever after; a viewer without a session or without the chat's grant sees the panels full-width as today.
- R3. Below the wide breakpoint the chat folds behind a control the maintainer chooses at check-in; the panels' own layout rules are unchanged.
- R4. The page's seed carries both halves at one `at`, so a row the chat cites is the row the panel paints; screenshots regenerate for both themes.

**The orchestrator preset and the reads (record 0070, criteria 3 and 5; U2)**

- R5. `orchestrator` is a preset in the capability tables: no workspace, no shell; its tool set is the plane's read commands, the operator's projection and the thread's own session tools; its instructions name the twelve nouns and require every fleet fact to cite the table row it read.
- R6. A fleet question in the thread is answered from the plane's projections — the same rows `plane_show` and the panels carry — never from the model's context alone; a question the tables cannot answer says so instead of recalling.
- R7. The preset resolves through the config layers like any other; nothing hardcodes it to the page, and `agent:orchestrator` works from any channel a grant admits.

**The writes through the door (record 0070, criteria 4 and 6; U3)**

- R8. The plan seed, `runs stop` and the admission and release moves are bindable from the orchestrator thread: the operator binds the sentence, the policy table authorizes the person, the blast-radius confirmation renders as the web chat's confirm card ([record 0044](../decisions/0044-a-routed-write-is-confirmed-in-proportion-to-its-blast-radius.md)).
- R9. A merge and a merge-queue enqueue become registry commands with policy rows, destructive annotations and refusals for an unapproved pull request or a red check; they call GitHub under an identity the person's grants and bindings resolve, never the App credential acting as nobody; the release pull request's merge is refused with the handoff card — that click stays a person's.
- R10. The thread holds no admission rule in prose: a move the decider owns is asked of the decider, and the preset's writes are exactly the registry commands its person's grants admit.

**Receipts, issues and the resume ledger (record 0070, "The shape"; U4)**

- R11. Deploy and feature receipts, and issue filing with run evidence, are bindable from the thread through the commands that exist for them; the answer is the same card the Slack door shows.
- R12. The thread's resume ledger is its own notes document, written by the preset at each day's close and seeded back on the next turn; it survives a deploy with the thread.

**The long thread's economics and acceptance (record 0070, difficulty 2; U5)**

- R13. The orchestrator thread's tail rides the operator's cap and folding; a measured receipt over a month of use (tail bytes, seed tokens, fold counts) is posted on the record before the preset defaults on for the page.
- R14. A deploy-survival test proves the thread's transcript and notes continue across a process restart; record 0070 flips to `accepted` with the receipt and the U1 screenshots.

### Scope Boundaries

- No second chat implementation, no new store, no new channel adapter; the column renders the web chat that exists.
- No standing service credential and no write outside the registry; the decider's conditions and moves stay record 0064's plan's.
- The `/threads` page keeps its route and remains the general chat.

### Deferred to Follow-Up Work

- A shared org-visible orchestration log distilled from the per-person threads.
- The chat column on other panel pages, if the plane's set grows.

### Open Questions

None open; two are the maintainer's at check-in: the narrow layout's fold and the column's default width.

---

## Planning Contract

### Key Technical Decisions

- **The column is the existing chat, rebound.** The web chat is already a channel adapter with seeds, cards and a composer; U1 mounts it against one thread key instead of the rail's selection. Rationale: record 0043 forbids a second chat path, and the cards must stay the door's own.
- **One thread per person, keyed on the session's identity.** Authority is personal (record 0042); a shared thread would need per-turn identity the channel seam does not carry.
- **Writes gain commands before the preset gains writes.** The merge and queue acts enter the registry with fences first (U3); the preset only ever binds what the registry defines.
- **Rules to the decider, words to the thread.** The preset's tool set carries the moves record 0064 leaves to a person and re-states no admission rule; the boundary is the tool list, not prose discipline.

### High-Level Technical Design

`web/src/pages/PlanePage.vue` gains the column and mounts the chat components `HomePage.vue` uses today, bound to the seed's orchestrator thread; `src/channels/planeView.ts` seeds both halves at one `at` and resolves the person's thread key. `src/core/budgets.ts` and the capability tables add the `orchestrator` preset; its instructions live with the other presets'. The merge and queue commands land under `src/core/commands/` with policy rows in `src/core/authz/`; the operator's binding, fences and tail (`src/core/dispatch/operator.ts`, `seed.ts`) are used as they are. The resume ledger rides the thread's session notes; the survival test rides the existing restart harness.

### Assumptions

- The dashboard session resolves a person for every viewer the chat should admit (record 0042); a session-less viewer degrades to the read-only page.
- The plane's read projections are cheap enough to serve per chat turn at a person's cadence; they already serve the page and the MCP tool.
- The GitHub identity the merge needs can be resolved from the person's binding as record 0062 resolves authorship; U3 hands back a deviation if it cannot, per the record's third change-our-mind row.

## Implementation Units

| U-ID | Title | Key files | Depends on |
|---|---|---|---|
| U1 | The two-column page, the existing chat pinned to the person's orchestrator thread | `web/src/pages/PlanePage.vue`, `web/src/pages/plane.test.ts`, `src/channels/planeView.ts`, `docs/reference/specs/orchestration-plane.md`, screenshots | — |
| U2 | The `orchestrator` preset: reads answered from the tables | `src/core/budgets.ts`, the preset instructions, `src/core/dispatch/route.ts` tables, `docs/reference/specs/routing-and-config.md` | U1 |
| U3 | The writes through the door: seed, stop, moves; the merge and queue commands born fenced | `src/core/commands/`, `src/core/authz/policy.ts`, `docs/reference/specs/command-registry.md`, `docs/reference/specs/orchestration-plane.md` | U2 |
| U4 | Receipts, issues and the resume ledger on the thread | the preset instructions, `src/core/commands/friction.ts` neighbours, `docs/reference/specs/web-chat.md` | U2 |
| U5 | The long thread's receipt, deploy survival, the record's acceptance | `src/core/dispatch/seed.ts` fold tuning if the receipt demands it, `docs/decisions/0070-*.md` | U1 to U4 |

### U1. The two-column page

- **Scope**: R1 to R4. The maintainer's check-in on the layout (column width, the narrow fold) comes first, on a draft; then tests — `plane.test.ts` asserts the column renders the chat bound to the viewer's thread, a session-less viewer gets the full-width panels, and both halves share one `at` — then the code, the spec row and `npm run screenshots:gen`.
- **Blast radius**: the plane page only; `/threads` and the panels' row logic untouched.
- **Validation**: the tests by name; before and after screenshots on the pull request (human-gated).

### U2. The orchestrator preset

- **Scope**: R5 to R7. Tests first: the preset's capability row (no workspace, the read tool set), a fleet question answered with a cited row, a question the tables cannot answer refusing to recall, `agent:orchestrator` resolving through the layers.
- **Blast radius**: additive preset; no existing preset's tables change.
- **Validation**: the tests; a live receipt of one cited answer on the page, posted on the pull request.

### U3. The writes through the door

- **Scope**: R8 to R10. Tests first: each act bound and confirmed at its blast radius, the merge refused on an unapproved pull request and on the release pull request (the handoff card), the enqueue recorded under the person's name, a grant-less person refused by the policy table.
- **Blast radius**: new commands and policy rows; the operator's binding unchanged.
- **Validation**: the tests; the merge attribution proven against a real pull request on the receipts issue before the preset holds the command.

### U4. Receipts, issues and the resume ledger

- **Scope**: R11 and R12. Tests first: a receipt turn renders the door's card; the ledger note written, then seeded on the next turn.
- **Blast radius**: preset instructions and thread notes; no command changes.
- **Validation**: the tests; one day's ledger round-trip shown on the pull request.

### U5. Economics, survival, acceptance

- **Scope**: R13 and R14. The month's cost receipt over the maintainer's real thread; the restart test; the record's acceptance with its receipts.
- **Blast radius**: fold tuning only if the receipt demands it, behind its own test.
- **Validation**: the receipt on the record; the survival test by name.

## Verification Contract

The record's validation criteria, each bound to the test its unit lands:

| Criterion | Proof |
|---|---|
| The plane page pins the chat column bound to the viewer's orchestrator thread; a session-less viewer gets the panels full-width | `web/src/pages/plane.test.ts::the plane page pins the orchestrator thread beside the panels` [gap: unit one] |
| Both halves of the page read one seed clock | `web/src/pages/plane.test.ts::the panels and the chat share one at` [gap: unit one] |
| A fleet question is answered from the plane's tables with the row cited, never from memory | `src/core/dispatch/route.test.ts::the orchestrator preset answers a fleet question from the tables` [gap: unit two] |
| A write typed in the thread is bound, authorized against the person and confirmed at its blast radius | `src/core/commands/plane.test.ts::a move from the orchestrator thread is fenced like the Slack door` [gap: unit three] |
| The merge command refuses an unapproved pull request and hands the release merge to a person | `src/core/commands/merge.test.ts::the merge refuses unapproved heads and hands the release to a person` [gap: unit three] |
| The resume ledger survives to the next turn and the thread survives a deploy | `src/core/dispatch/reattach.test.ts::an orchestrator thread continues across a restart with its notes` [gap: unit five] |
| The long thread's cost receipt and the U1 screenshots are on the record at acceptance | human-gated, posted on record 0070 [gap: unit five] |

- Every unit: the changed set's own gates — `npx vitest run` on the touched test files by name, `tsc --noEmit -p` the touched tsconfig, `npx prettier --check` on the changed files, `npm run specs:check`, `npm run hygiene:check`, `npm run check:pr-title` — plus the fixtures it touches regenerated by their `gen`; the full suite and `npm run verify` are CI's on the push.
- U1: `npm run screenshots:check` clean after `screenshots:gen`; the layout check-in recorded on the pull request before it leaves draft.

## Definition of Done

- The five pull requests are merged and live; `/plane` holds the maintainer's whole day — the panels beside a thread that reads the fleet from the tables, acts through the door under the person's grants, posts the receipts and keeps the ledger — and record 0070 is `accepted` with the cost receipt and the screenshots.
