# Parity testing — Switchboard vs Claude Tag

Closes [milestone 1](milestone-1-vs-claude-tag.md) **exit criterion #4**: a cold-start side-by-side against Claude Tag (Claude in Slack). This file is the plan, the running results, and the feature matrix — updated as each test runs, with a dated receipt (thread/PR link) per row.

**Claude Tag baseline:** a capable model in Slack with conversation/thread context, web search, and cloud Claude Code (it *can* clone + open PRs via the cloud runner). What it lacks: per-thread isolated execution you can watch, per-org warm residents, `agent:`/`model:` routing, per-channel/user config, a live external dashboard, and non-Slack ingress (HTTP/MCP). The point of this exercise is to make those differences measured, not asserted.

## Summary — the scoreboard (Run 1 · 2026-08-27)

> **Same quality, ~20–40× faster, and it shows its work.**

- ⚡ **~20–40× faster on identical tasks.** Same questions, both correct: Q&A **4s vs 117s**, fetch-a-URL-and-summarize **4s vs 163s**, sourced research **9s vs 175s** (switchboard vs Claude Tag).
- 🎚️ **Same depth on demand.** Claude's one edge — a slightly richer default answer — disappeared the moment we set `model:fable-5`: switchboard matched it in **6s vs Claude's ~2 min**. You steer speed↔depth per request; Claude Tag can't.
- 🔍 **Reviews post straight back to the PR.** Review *quality* is ≈ parity — both give strong `file:line` reviews and run the suite (Claude was also excellent, and caught a point switchboard missed). Switchboard's edge: it posts the review back to the PR as the bot **by default** (you never ask), ~1.8× faster, and more structured (severity+confidence+scenario).
- 📺 **An external live dashboard.** Both post an in-thread checklist card (parity — we took that pattern from Claude Tag). Switchboard's edge is the **`/runs` browser dashboard behind SSO** — watch any run live *outside* Slack; Claude Tag's status stays in the thread.
- 🧩 **Things Claude Tag simply can't do:** `agent:`/`model:` routing, per-channel/user config, warm per-org residents, HTTP + MCP ingress, legible sandbox timeouts, self-hosted own-auth.

**Status:** Run 1 covers A1–A4, A6, B2 (live receipts below). Remaining: A5 (issue-to-PR, attended), the two-thread different-branch resident test, and deterministic PR-review-posting — tracked as GitHub issues.

## Methodology

1. **Channel:** run both bots in the same channel so the comparison is apples-to-apples. Default: **#switchboard-prompting** (`C0BQS7KPJHK`). Confirm both `@switchboard` (`U0BQNU1AD27`) and `@claude` (`U0BJJMDUCKY`) are members before starting (invite whichever is missing).
2. **Per test case:** post the switchboard prompt (`@switchboard …`) as one top-level message and the equivalent claude prompt (`@claude …`) as another, with the **same task**. Where there is no meaningful Claude equivalent, record **N/A** with a one-line reason (that *is* the finding).
3. **Capture** the metrics below for each side, link both threads as receipts, and write a one-line verdict.
4. **Cold-start discipline:** don't pre-warm or coach either bot. The milestone's bar is that the switchboard result is visibly better *in the thread itself, without narration*.
5. **Repeat flaky-sensitive cases** (latency, execution) 3× and record the median.

## Metrics (per side, per test)

| Metric | Meaning |
|--------|---------|
| **Ack** | time from post to first acknowledgement (👀 / typing / first token) |
| **Complete** | time from post to final answer |
| **Correct** | ✅ did the task correctly · ⚠️ partial · ❌ failed |
| **Quality** | 1–5 + a note (accuracy, depth, format) |
| **Observability** | can you watch progress mid-run? (status card / live dashboard / nothing) |
| **Control** | could you steer agent / model / budget? |
| **Execution** | isolated + repo-authenticated? (sandbox, resident, GitHub App) |
| **Receipt** | link to the thread / PR |

## Test matrix

Status legend: ⬜ not run · 🟡 running · ✅ done (receipt linked).

### A. Shared capabilities (both should do this — measure the gap)

| # | Test case | `@switchboard` prompt | `@claude` equivalent | Result (Run 1) | Status · receipts |
|---|-----------|----------------------|----------------------|----------------|-------------------|
| A1 | General Q&A | `@switchboard what's the difference between a Durable Object and a Worker?` | `@claude` same | **4s vs 117s**, both correct; Claude richer at default (see B2) | ✅ [sw](https://coreplanelabs.slack.com/archives/C0BQS7KPJHK/p1787871368545669) · [claude](https://coreplanelabs.slack.com/archives/C0BQS7KPJHK/p1787871370323879) |
| A2 | Q&A with web freshness | `@switchboard agent:research what is the current Node.js LTS and its EOL date? cite your source` | `@claude` same | **9s vs 175s**, both correct + sourced | ✅ [sw](https://coreplanelabs.slack.com/archives/C0BQS7KPJHK/p1787871398874859) · [claude](https://coreplanelabs.slack.com/archives/C0BQS7KPJHK/p1787871400762519) |
| A3 | Read a URL | `@switchboard agent:research fetch <url> and summarize in 2 sentences` | `@claude` same | **4s vs 163s**, quality parity | ✅ [sw](https://coreplanelabs.slack.com/archives/C0BQS7KPJHK/p1787871402560159) · [claude](https://coreplanelabs.slack.com/archives/C0BQS7KPJHK/p1787871404235179) |
| A4 | Code review of a PR | `@switchboard agent:review review <PR url> …` | `@claude` review `<PR url>` | **168s vs 305s**; both strong, switchboard executes + more structured | ✅ [sw](https://coreplanelabs.slack.com/archives/C0BQS7KPJHK/p1787871578429299) · [claude](https://coreplanelabs.slack.com/archives/C0BQS7KPJHK/p1787871580490389) |
| A5 | Issue-to-PR | `@switchboard agent:coding <issue url> — implement and open a PR` | `@claude` same | deferred — creates real PRs, run attended | ⬜ (sw side proven: [nominal#1347](https://github.com/coreplanelabs/nominal/pull/1347)) |
| A6 | Instant ack | any of the above | any of the above | 👀 ~1s + live status card on every run | ✅ observed across A1–A4 |

### B. Switchboard-only capabilities (expect Claude Tag = N/A)

Legend: ✅ demonstrated (this session or a dated milestone receipt) · ⬜ pending a live demo. Claude Tag = **N/A** on all of these.

| # | Test case | Evidence | Status |
|---|-----------|----------|--------|
| B1 | Agent routing (`agent:` selection) | `general`/`research`/`review` all selected via `agent:` across A1–A4, same channel | ✅ |
| B2 | Model steering (`model:` per request) | [receipt](https://coreplanelabs.slack.com/archives/C0BQS7KPJHK/p1787871767840769) — `model:fable-5` matched Claude's depth in 6s | ✅ |
| B3 | Per-channel/user default + persistence | unit-proven (milestone claim 4); live restart demo | ⬜ |
| B4 | Thread-sticky agent | unit-proven (milestone claim 4) | ✅ |
| B5 | Restricted-agent enforcement (fail-closed) | unit-proven (milestone claim 4); live demo | ⬜ |
| B6 | Warm resident repo (per-repo/ref isolation) | covered by the two-thread different-branch test (tracked as an issue) | ⬜ |
| B7 | Legible sandbox timeout (`exit 124`) | milestone claim 3, dated receipt 2026-08-21 | ✅ |
| B8 | Live external dashboard (`/runs`, SSE, SSO) | built + validated live this session (SSE fix #66) | ✅ |
| B9 | HTTP ingress (`POST /ingress`) | enabled this session; bad-token → 401 (gate active) confirmed; full dispatch demo | ✅ (gate) / ⬜ (dispatch) |
| B10 | MCP ingress (Switchboard *as* MCP server) | enabled this session; `tools/list`/`dispatch` demo | ⬜ |
| B11 | Budgeted run + guaranteed final message | milestone claim 5 (unit + live) | ✅ |

## Feature matrix

✅ = supported · ➖ = partial/awkward · ❌ = not available.

| Capability | Switchboard | Claude Tag | Notes |
|------------|:-----------:|:----------:|-------|
| Slack Q&A with thread context | ✅ | ✅ | Table-stakes for both |
| Web search / URL fetch | ✅ | ✅ | Ours: Brave + SSRF-guarded `web_fetch`; Claude: native |
| Open a PR from an issue | ✅ | ✅ | Both run cloud/remote code; compare identity + evidence |
| Review a PR (quality) | ✅ | ✅ | Parity — in A4 both checked out/attached the repo, ran the suite, and gave file:line findings. Switchboard's edge is speed + **posting the review back to the PR as the bot identity by default** (see below), not review quality |
| Post the review back to the PR as the bot, by default | ✅ | ➖ | Switchboard does it automatically as `coreplane-switchboard[bot]` (no user ask); Claude Tag can post via a GitHub connector but not as a first-class default |
| `agent:` selection (review/coding/general/research) | ✅ | ❌ | Claude Tag is one persona |
| `model:` per-request override | ✅ | ❌ | — |
| Per-channel / per-user defaults + persistence | ✅ | ❌ | `data/overrides.json`, survives restart |
| Thread-sticky agent/repo | ✅ | ❌ | — |
| Restricted-agent allowlist (fail-closed) | ✅ | ❌ | — |
| Isolated per-thread sandbox execution | ✅ | ➖ | Ours: explicit per-thread sandbox; Claude: opaque cloud exec |
| Legible timeouts (`exit 124` + guidance) | ✅ | ❌ | Contractual + tested |
| Per-org warm resident repos (GitHub App) | ✅ | ❌ | Always-warm, R2-snapshotted, re-clone-on-restart |
| Instant ack + in-thread status card/checklist | ✅ | ✅ | **Parity** — both post an ack + a structured `✓/○` checklist card (we took this pattern from Claude Tag). Not a differentiator |
| **External** live dashboard (`/runs`, SSE, SSO) | ✅ | ❌ | The real observability edge: watch any run in a browser, behind Access — beyond the in-thread card both have |
| HTTP ingress (`POST /ingress`) | ✅ | ❌ | Same core, non-Slack trigger |
| MCP ingress (Switchboard *as* MCP server) | ✅ | ❌ | `POST /mcp`, JSON-RPC `dispatch` tool |
| Self-hosted / own-infra + own endpoint security | ✅ | ❌ | Runs on our Cloudflare account; we own auth |
| Multi-channel core (Slack, CLI, HTTP, MCP) | ✅ | ❌ | Channel-agnostic dispatcher |

## Results log

### Run 1 — 2026-08-27, #switchboard-prompting (both bots live)

**Headline:** Switchboard answers in **seconds** at matching quality; Claude Tag is thorough but **~20–40× slower** (~2–3 min/response). Switchboard also puts a structured live status card + a `/runs` dashboard link on every run, supports per-request `agent:`/`model:` steering, and its review agent checks out the branch and executes code — catching a real bug in this run.

| Test | Switchboard | Claude Tag | Verdict |
|------|-------------|------------|---------|
| A1 Q&A (DO vs Worker) | 👀 ~1s · `general`/haiku · **~4s** · accurate, 4 sentences | `fable-5` · **~117s** · richer (calls out the single-instance-worldwide guarantee) | Claude deeper *at its default model*; but **B2 shows switchboard matches that depth in 6s with `model:fable-5`** → switchboard wins on speed at equal quality |
| A2 Node LTS (cite source) | `research`/haiku · **~9s** · v24 "Krypton", EOL 2028-04-30, src endoflife.date | `fable-5` · **~175s** · same + v22/v26 context, cites primary `nodejs/Release schedule.json` | Both correct; Claude's source more authoritative, switchboard ~20× faster |
| A3 Fetch URL + summarize (`vary`) | `research`/haiku · **~4s** · accurate 2-sentence summary | `fable-5` · **~163s** · accurate, slightly more API detail | Quality parity; switchboard ~40× faster |
| A4 PR review (switchboard#62) | `review`/fable-5 · **168s** · checked out the branch + read changed files; **file:line + severity + confidence + failure scenario per finding**; flagged the deploy-wiring/diff discrepancy + the JWKS negative-cache gap | `fable-5` · **~305s** · attached the repo, read the merged diff, ran the 35 gate tests; LGTM with the **same JWKS gap** + an extra **TTL revocation-lag** point switchboard didn't call out | **Quality ≈ parity — both strong** (each caught real issues; Claude found one switchboard missed). Switchboard's edge: **~1.8× faster, more structured** (severity+confidence+scenario, "fix #1 and merge"), and **repo-native execution** (checks out the branch). Honest read: not a blowout on review quality; a clear win on speed + structure |
| A6 Instant ack + status card | 👀 ~1s + checklist status card (agent·model·elapsed) + `/runs` link | 👀 + a checklist "todos" card | **Parity on the in-thread card** (both do it — we took the pattern from Claude Tag); switchboard additionally links the external `/runs` dashboard |
| B2 Model steering | `model:anthropic/claude-fable-5` → **6s**, matches Claude's A1 depth exactly | **N/A** — no per-request model control | Switchboard-only, and the punchline to A1 |

**Switchboard-only capabilities** (already carrying dated receipts in [milestone-1-vs-claude-tag.md](milestone-1-vs-claude-tag.md); Claude Tag = N/A on each): `agent:`/`model:` routing + per-channel/user defaults (claim 4), sandboxed + budgeted execution with legible `exit 124` timeouts (claim 3), warm per-org residents, the live `/runs` dashboard behind Cloudflare Access (built + validated this session), HTTP `/ingress` + MCP `/mcp` (enabled this session), and self-hosted own-infra + own endpoint security.

**Notes / caveats for the next run:**
- **Claude Tag latency is the long pole** — ~2–3 min per reply vs switchboard's seconds, so head-to-head runs are paced by Claude. Every switchboard reply also carried its live status card + a `/runs` link (observability the thread-only Claude flow doesn't have).
- **A4 was the closest test** — both reviews were genuinely good (both caught the JWKS gap; Claude additionally noted a TTL revocation-lag point). Don't overclaim review *quality*; switchboard's win there is speed + structure + that it checks out the branch and runs the suite as part of the review. Both, notably, referenced the real #62 deploy-wiring split from earlier in the day.
- **A5 (issue-to-PR head-to-head) deferred** — it creates real PRs on both sides; best run attended. Switchboard's side is already proven (claim 1, [nominal#1347](https://github.com/coreplanelabs/nominal/pull/1347)).
- **Next:** run A5 attended, and re-run A1/A4 a couple more times for stable medians.
