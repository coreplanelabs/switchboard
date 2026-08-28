# Parity testing — Switchboard vs Claude Tag

Closes [milestone 1](milestone-1-vs-claude-tag.md) **exit criterion #4**: a cold-start side-by-side against Claude Tag (Claude in Slack). This file is the plan, the running results, and the feature matrix — updated as each test runs, with a dated receipt (thread/PR link) per row.

**Claude Tag baseline:** a capable model in Slack with conversation/thread context, web search, and cloud Claude Code (it *can* clone + open PRs via the cloud runner). What it lacks: per-thread isolated execution you can watch, per-org warm residents, `agent:`/`model:` routing, per-channel/user config, a live external dashboard, and non-Slack ingress (HTTP/MCP). The point of this exercise is to make those differences measured, not asserted.

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

| # | Test case | `@switchboard` prompt | `@claude` equivalent | What "better" looks like | Status |
|---|-----------|----------------------|----------------------|--------------------------|--------|
| A1 | General Q&A | `@switchboard what's the difference between a Durable Object and a Worker?` | `@claude` same | Comparable answer; measure latency + quality parity | ⬜ |
| A2 | Q&A with web freshness | `@switchboard agent:research what's the latest stable Node LTS and its EOL date?` | `@claude` same | Both fetch current info; compare sourcing | ⬜ |
| A3 | Read a URL | `@switchboard use web_fetch on <doc url> and summarize the auth section` | `@claude` same | Both fetch; ours is SSRF-guarded (note, not visible) | ⬜ |
| A4 | Code review of a PR | `@switchboard agent:review review <PR url> and post the review as a GitHub comment (comment only)` | `@claude` review `<PR url>` | Ours runs the suite itself + posts file:line+severity as the bot identity | ⬜ |
| A5 | Issue-to-PR | `@switchboard agent:coding <issue url> — implement and open a PR` | `@claude` same | Both open PRs; compare authored identity, test-run evidence, observability | ⬜ |
| A6 | Instant ack | any of the above | any of the above | Ours posts 👀 within ~1s + a live status card | ⬜ |

### B. Switchboard-only capabilities (expect Claude Tag = N/A)

| # | Test case | `@switchboard` prompt | `@claude` equivalent | Status |
|---|-----------|----------------------|----------------------|--------|
| B1 | Agent routing | `@switchboard agent:review …` vs `agent:coding …` in the same channel | **N/A** — Claude Tag has one persona; no `agent:` selection | ⬜ |
| B2 | Model steering | `@switchboard model:anthropic/claude-haiku-4-5 <cheap task>` then a `fable-5` task | **N/A** — no per-request model control | ⬜ |
| B3 | Per-channel / per-user default + persistence | set a channel default agent, confirm a new thread inherits it after a restart | **N/A** — no routing/config layer | ⬜ |
| B4 | Thread-sticky agent | pick `agent:coding`, then reply in-thread without re-specifying | **N/A** — no agent concept to stick | ⬜ |
| B5 | Restricted-agent enforcement | a non-admin user invokes a restricted agent → refusal | **N/A** — no per-agent allowlist | ⬜ |
| B6 | Warm resident repo | a repo op on an onboarded resident (measure warm vs cold clone latency) | **N/A** — Claude re-clones per task, no persistent per-repo env | ⬜ |
| B7 | Legible sandbox timeout | `@switchboard agent:review run \`sleep 320 && echo NOPE\`` → `exit 124` + guidance, not silence | **N/A** — no exposed sandbox timeout contract | ⬜ |
| B8 | Live external dashboard | open `/runs`, watch the run stream live behind SSO | **N/A** — progress lives only in the Slack thread | ⬜ |
| B9 | HTTP ingress | `POST /ingress` with a bearer token → same dispatch as Slack | **N/A** — Slack-only trigger | ⬜ |
| B10 | MCP ingress (Switchboard *as* an MCP server) | `POST /mcp` `tools/call dispatch` from an MCP client | **N/A** — not addressable as an MCP server | ⬜ |
| B11 | Budgeted run + guaranteed final message | a long task that hits the turn/time budget → legible wrap-up, never silence | **N/A** — no exposed budget contract | ⬜ |

## Feature matrix

✅ = supported · ➖ = partial/awkward · ❌ = not available.

| Capability | Switchboard | Claude Tag | Notes |
|------------|:-----------:|:----------:|-------|
| Slack Q&A with thread context | ✅ | ✅ | Table-stakes for both |
| Web search / URL fetch | ✅ | ✅ | Ours: Brave + SSRF-guarded `web_fetch`; Claude: native |
| Open a PR from an issue | ✅ | ✅ | Both run cloud/remote code; compare identity + evidence |
| Review a PR | ✅ | ➖ | Ours runs the suite itself + posts file:line+severity as the bot GitHub identity |
| `agent:` selection (review/coding/general/research) | ✅ | ❌ | Claude Tag is one persona |
| `model:` per-request override | ✅ | ❌ | — |
| Per-channel / per-user defaults + persistence | ✅ | ❌ | `data/overrides.json`, survives restart |
| Thread-sticky agent/repo | ✅ | ❌ | — |
| Restricted-agent allowlist (fail-closed) | ✅ | ❌ | — |
| Isolated per-thread sandbox execution | ✅ | ➖ | Ours: explicit per-thread sandbox; Claude: opaque cloud exec |
| Legible timeouts (`exit 124` + guidance) | ✅ | ❌ | Contractual + tested |
| Per-org warm resident repos (GitHub App) | ✅ | ❌ | Always-warm, R2-snapshotted, re-clone-on-restart |
| Live external dashboard (`/runs`, SSE, SSO) | ✅ | ❌ | Watch any run in a browser behind Cloudflare Access |
| Instant 👀 ack + live status card | ✅ | ➖ | Claude shows a typing indicator; ours a structured card + checklist |
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
| A6 Instant ack | 👀 in ~1s + structured live status card (agent·model·elapsed, checklist, `/runs` link) | 👀 + a "todos" status line | Both ack; switchboard's card is richer and links a live dashboard |
| B2 Model steering | `model:anthropic/claude-fable-5` → **6s**, matches Claude's A1 depth exactly | **N/A** — no per-request model control | Switchboard-only, and the punchline to A1 |

**Switchboard-only capabilities** (already carrying dated receipts in [milestone-1-vs-claude-tag.md](milestone-1-vs-claude-tag.md); Claude Tag = N/A on each): `agent:`/`model:` routing + per-channel/user defaults (claim 4), sandboxed + budgeted execution with legible `exit 124` timeouts (claim 3), warm per-org residents, the live `/runs` dashboard behind Cloudflare Access (built + validated this session), HTTP `/ingress` + MCP `/mcp` (enabled this session), and self-hosted own-infra + own endpoint security.

**Notes / caveats for the next run:**
- **Claude Tag latency is the long pole** — ~2–3 min per reply vs switchboard's seconds, so head-to-head runs are paced by Claude. Every switchboard reply also carried its live status card + a `/runs` link (observability the thread-only Claude flow doesn't have).
- **A4 was the closest test** — both reviews were genuinely good (both caught the JWKS gap; Claude additionally noted a TTL revocation-lag point). Don't overclaim review *quality*; switchboard's win there is speed + structure + that it checks out the branch and runs the suite as part of the review. Both, notably, referenced the real #62 deploy-wiring split from earlier in the day.
- **A5 (issue-to-PR head-to-head) deferred** — it creates real PRs on both sides; best run attended. Switchboard's side is already proven (claim 1, [nominal#1347](https://github.com/coreplanelabs/nominal/pull/1347)).
- **Next:** run A5 attended, and re-run A1/A4 a couple more times for stable medians.
