---
title: The one door has one execution path — after the operator decides, a registry command runs through the class ladder or is offered as one click, a preset runs the request through the route, every violation is re-asked at the seam, every disagreement floors to the route, and nothing on a chat surface is ever handed back as text to retype
status: proposed
date: 2026-09-20
pattern: One decision table owned by one module (bind kind × surface → run / click / route / re-ask / refuse), asked by every caller and rendered by none of them; the seam as the only re-ask and the route as the only floor; a rendered line to retype made unrepresentable on a chat surface, so the defect class cannot recur site by site
---

# The one door has one execution path: a bind runs, clicks or routes; a violation is re-asked, a disagreement floors, and no chat surface hands back a line to retype

**The ask.** Decide (the maintainer, after the operator's first day as the default door): everything after the operator's decision goes through one execution table — bind kind × surface → run / click / route / re-ask / refuse — owned by one module, with [record 0067](0067-one-seam-for-a-structured-answer-a-violation-is-re-asked-with-the-violation-named-and-the-callers-declared-floor-holds-never-a-refusal-shown-to-the-person.md)'s seam as the only re-ask and the route as the only floor. This is a survey-driven collapse, not another patch: the day's fourteen defects were fourteen branches of the same missing rule, each fixed (or in flight) at its own render site, and a fifteenth site is a matter of time. Written for an engineer who knows the dispatcher's stages, record 0057 and plan 002. Success criteria:

1. One module owns the outcome of every bind the operator or the route stage produces; no caller — the dispatcher, the operator executor, the route stage, admission, the verifier — renders a line for a person to type or decides a bind's fate on its own.
2. A registry command below the effective confirm class runs through the class ladder; at or above it, on a chat surface, it is offered as one click through record 0044's store — the same mint whichever caller asks, never a `To run this:` beside a button.
3. A preset bind runs the person's own request through the route stage; a typed registry line runs as the person typed it, never re-spelled; a steer folds under the owner rule, read before any directive.
4. Every shape or content violation is the seam's re-ask; every disagreement between the door's own models — the verifier's, or a transport failure standing in for one — floors to the route, which runs the request; neither is ever a sentence handed to the person.
5. Each of the day's fourteen defects is a replay fixture that holds, so the day's failures become the regression suite.

## TL;DR

On the operator's first day as the default door, production filed fourteen defects and every one is the same defect: after the model decides, five different modules each decide for themselves what to do with a bind, and four of them can end the conversation by printing a line for the person to retype. Preset binds were never executed; the verifier refused correct binds with misread reasons and handed the line back instead of falling to the route; a typed `runs stop` was re-bound into a spelling no chat grammar parses while a runaway run burned; a directive reply in a live pipeline's seed thread started a rival run; a refusal's text reached the person cut at its first parenthesis; and the hand-back lines themselves — bare `ship`, `ship --repo …`, `runs_stop --run …` — could not run as pasted. The bet: one execution table, bind kind × surface → run / click / route / re-ask / refuse, owned by one module every caller asks and none re-implements; the seam (record 0067) is the only re-ask, the route is the only floor, and on a chat surface no path renders text to retype — the click is the confirmation, the route is the recovery. It costs one module, the migration of eight render sites and three decide sites onto it, and fourteen fixtures. Doing nothing means the next defect lands at whichever site the last patch missed, and each fix ships as its own branch of a rule nobody wrote down.

## Today at `b19caf8a`

The door as 1.255.0 ships it, then the fourteen defects one day of production found — all on this door. Every claim verified at head.

**The door's own render and decide sites.** The enumeration the collapse reduces:

| Site | What it does on its own | Proof at `b19caf8a` |
| --- | --- | --- |
| The route stage's write answer | a routed write without a click affordance or a store is answered `To run this: <receipt>`; a store unreachable at mint appends a note to the same hand-back; a secret-shaped line answers `type the line yourself` | `src/core/dispatch/route.ts` lines 1583 to 1610 (`answerCommand`), `UNSHOWABLE_LINE` |
| The cut note | a hand-back over the receipt cap carries a second line admitting the line "will not run as pasted" — a rendered line that documents its own unrunnability | `route.ts` line 137 (`HAND_BACK_CUT_NOTE`) |
| The operator executor, three hand-backs | a bind neither the registry nor the preset table parses is handed back; a write-class registry bind under the confirm class is handed back with its receipt — never the click the route stage's own path mints for the same command; every bind after a preset bind is handed back | `src/core/dispatch/operator.ts` lines 943, 953, 966 (`executeOperatorDecision`) |
| The verifier's disagreement | a disagreement — a misjudged bind, a transport failure, a timeout, no model — hands the bound line back to type and the bind runs nothing | `operator.ts` (`verifyOperatorBind`, the `!verdict.agrees` branch); `src/core/dispatch/reply.ts` line 407 (`renderVerifierHandBack`) |
| The dispatcher's typed short-circuit | a message the chat grammar parses, or one opening with an `agent:` directive, turns the operator off for the event — stage A decides the bind | `src/core/dispatcher.ts` lines 608 to 611 (`typedDecision`) |
| Admission's directive read | the follow-up rule reads `directives.agent` as typed intent, so a directive reply skips the owner rule | `dispatcher.ts` line 814; `src/core/dispatch/admission.ts` lines 500 and 601 (`decideFollowUp`) |
| The paste machinery | a subsystem exists to recognize a hand-back's paste and record it — machinery whose only job is observing the person retype what the door printed | `src/core/dispatch/fastPath.ts` (`pastedRoute`); routing-and-config item 21's `outcome: pasted` rows |

**The fourteen defects.** One day under `on`, each a fixture the plan adds (D1 to D14):

| # | Defect | Proof |
| --- | --- | --- |
| D1 | a plain-words fix ask bound to a `ship` line without the person's words — the task text gone from every bind | issue 1993 |
| D2 | `ship` bound with flags the registry does not have (`--repo`, `--issue`, `--branch`, `--base`, `--title`, `--body`) | issue 1993 |
| D3 | the hand-back line a bare `ship` — a line that cannot run as pasted ("Nothing to ship") | issue 1993 |
| D4 | the seed directive rewritten and doubled (`ship agent:ship in …`) instead of passing through | issue 1993 |
| D5 | a preset bind never executed: the right preset bound with the right argument, and no run followed — reads dead as well as writes | issue 1993 |
| D6 | the verifier refusing correct preset binds with misread reasons ("binding is a run, not a fix command") — judging whether the author typed the preset instead of whether the preset fits | issue 1993 |
| D7 | a reply into a live unit's round bound as prose the registry cannot parse, handed back, the follow-up lost — no fold, no trace in the handoff | issue 1993 |
| D8 | the typed line `runs stop <id> --mode hard` re-bound into the MCP spelling `runs_stop --run … --mode hard`, which the chat grammar does not parse — the stop never ran while a runaway run burned | issue 1993 |
| D9 | an `agent:` directive reply in a live pipeline's seed thread started a rival coding run beside the pipeline instead of folding or being refused | issue 2010 |
| D10 | a typo'd directive word (`adgent:` for `agent:`) drew a refusal instead of the bind the words meant | issue 2025 |
| D11 | the refusal's text reached the person — and the record — cut at its first parenthesis: `This request has a typo (` | issue 2025 |
| D12 | the verifier calling the verbatim line a duplication: the bound preset line put the directive in front of a request already opening with a directive-shaped token, and the mangled line was handed back to type | issue 2025 |
| D13 | the operator's own `To run this:` text beside record 0044's confirmation click — two code paths for one concept, the route stage minting the click the operator's path never asks for (the fix in flight) | `operator.ts` line 966 beside `route.ts` `answerCommand`; issue 1993 |
| D14 | the verifier's failure mode a hand-back rather than a floor: a transport failure or a judgement miss ends the ask with a line to retype instead of letting the route run the request (the fix in flight) | `renderVerifierHandBack`; issue 1993 |

Fixes D1, D5, D6 and D8's interim carve-outs shipped by 1.255.0 as patches at their own sites — the preset-bind execution, the verifier's preset vocabulary, the operator's word-drop guard (record 0067 as amended), the typed-line and directive short-circuits — which is exactly the accretion this record collapses: each patch is one more site deciding on its own.

## The shape

One module, `src/core/dispatch/execution.ts` (the plan names the files), owning the table every caller asks:

| Bind kind | On a chat surface (Slack, the web chat) | On a typed surface (CLI, HTTP, MCP) |
| --- | --- | --- |
| a registry bind below the effective confirm class | **run** through the class ladder, the receipt naming the line, the class verdict and the reason | run, the same |
| a registry bind at or above the confirm class | **click**: record 0044's row, minted by the one offer path, the full bound line on the button; a store unreachable or an unshowable line is a **refuse** naming why — never a line to retype | refuse naming the typed form — typing is that surface's native act, so naming the line there is the refusal's way forward, not a hand-back |
| a preset bind | **route**: the preset runs the person's own request through the route stage, the verifier's agreement on the receipt | route, the same |
| a steer bind | **run** as admission's fold under the owner rule — the thread's owner read before any directive | the same |
| a typed registry line (the person's own grammar parses it) | **run** as typed through the ladder — never re-spelled, never re-bound | run as typed |
| a shape or content violation (an unparseable line, dropped words, a mixed decision) | **re-ask** at the seam (record 0067), then the seam's declared floor: the route | the same |
| a verifier disagreement, failure or timeout | **route**: the readers' route runs the request, the disagreement on the record | the same |
| a model-authored refusal (`policy` or `request`) | **refuse** through record 0054's renderer — the text carried whole under the reason cap, never cut at a quote or a bracket; a `request` refusal is one question with the best guess | the same |

The properties the table enforces, which no site can enforce alone:

- **One owner.** Every caller — the route stage's answer, the operator executor, the confirm click, admission's fold, the verifier's return — asks the table and executes its cell; none renders its own line, so a new bind kind or surface is a new cell with a table test, not a new branch in five modules.
- **The seam is the only re-ask.** A bind the table cannot execute for a reason the model can repair (the parse, the dropped words, the mixed shape) is record 0067's violation, re-asked with the violation named; the table adds no second retry loop.
- **The route is the only floor.** When judgement fails — the seam's retries exhausted, the verifier disagreeing or failing — the request itself runs through the route stage, which is what the door did before the operator existed and what it fell back to on every patched path this week. A floored request never re-enters the operator (the floor is terminal for the event), so no loop.
- **No chat hand-back.** `To run this:` leaves every chat render; the cut note retires with it (a line never rendered to retype needs no unrunnability warning); the paste machinery retires when its input does. The click is the confirmation; the person's next message is the correction.
- **The owner rule is read before the bind.** A reply into a thread a live run or a pipeline owns is that owner's follow-up first — folded, or refused naming the thread to reply in — and only then a bind; a directive is honoured inside that rule, never around it (D9's fix as a table property, not an admission patch).

## One trace: a typed stop while a runaway run burns

The hard case is D8 and D9 together: the door's misreads created a runaway run, and the door then blocked the only chat path to stopping it.

1. A directive reply lands in a live pipeline's seed thread. Today: stage A reads `directives.agent` as typed intent, admission never asks the owner rule, and a rival coding run starts beside the pipeline (D9). After: the table's steer/owner row runs first — the thread's owner is the pipeline, so the reply folds into the unit's live child or is refused naming the unit thread; the directive is honoured inside that answer. No rival run exists.
2. Suppose it did (the world before the collapse): the person types `runs stop <id> --mode hard`. Today: the operator re-binds the typed line into `runs_stop --run <id> --mode hard`, the MCP spelling, and hands it back; the chat grammar does not parse the handed-back line, so typing it loops (D8). After: the typed-line row — the person's own grammar parsed it, so it runs as typed through the ladder. `runs stop` on one's own run is below the confirm floor for its requester: it runs; on another's run it is destructive: the click renders with the full line, one press stops the run.
3. Had the operator produced the bind instead (the person wrote "stop the runaway run" in prose), the same two rows answer it: a parsed `runs stop` bind runs or clicks by class; an unparseable paraphrase is the seam's re-ask, and after the retries the route floor runs the request — where the route stage's own reading of "stop the runaway run" gets its chance — never a `To run this:` that ends the ask.

The property: at no step does the person retype anything, and the worst model day degrades to the route, which is the door the product shipped with.

## The difficulty map

1. **Sequencing without a red day** (most care): the module lands first as a pure refactor — every site asks the table, every cell holding today's behavior byte for byte — and each behavioral change is one cell flipped in its own unit with its fixtures, so production is green between units and `routing.operator: off` stays the rollback lever throughout.
2. **The click on the operator's path**: record 0044's store holds one pending row per thread; the operator can produce several write binds in one decision, so the table must serialize them onto the one-row invariant (the first write clicks, the rest are refused naming the pending row) without double-minting.
3. **The route floor's re-entry**: a floored request runs the route stage after the operator already decided — the event must not re-enter the operator, the decision's attempts must ride the run that then runs, and the two `src/cli.ask.test.ts` process tests must pass through the floor unchanged.
4. **Retiring the paste machinery**: `outcome: pasted` rows, the web composer's hand-back prefill and the replay's paste counters all read the hand-back's existence; each retires with a spec row change in the same unit, or the ledger grows silent holes.

## Plan 002's remaining units

The collapse changes what three of the one-door plan's remaining units mean; plan 002 takes one dated note pointing here, and its unit table is not renumbered.

- **U12 (the directive words leave): absorbed.** The dispatcher's directive short-circuit (`typedDecision`) and stage A's directive read are two of the decide sites the table collapses; the deletion lands as the collapse's directive unit, gated by the directive replay row plus the day's two directive fixtures (D4, D10). U12 is not run as its own unit.
- **U13 (the typed command line leaves stage A): amended.** The day's evidence (D8) settled the open half of the plan's second key technical decision: a line the person's own grammar parses is the person's typed decision and runs as typed — permanently a deterministic row of the table, not an interim carve-out the operator later absorbs. What leaves is stage A as a separate render path: the parse moves behind the table's owner, and the operator is forbidden from re-spelling a parseable line by the table test rather than by prompt hope. U13 narrows to that move, gated by the command row as before.
- **U16 (the confirm default moves): narrowed, half unnecessary.** U16 existed to relax the write hand-back; under the table there is no hand-back to relax — a write on a chat surface is already one click. What remains is one cell: whether the write row's chat outcome is `run` or `click`, moved by the same gates U16 already names (the write and planted rows held twice on the final prompt, the requester fix deployed). U16 becomes that cell change.

U14, U15, U18 and U19 are untouched: the repository scan, the attach token and the lint rule delete readers ahead of the table; the seam (U19, shipped) is the re-ask column the table points at.

## Records this design amends

Each amendment lands as a dated `## Amended` note on the record in the same pull request as the unit that makes it true; the replacement sentences:

- **[Record 0039](0039-the-front-door-writes-nothing-from-prose-and-never-routes-twice.md)** ("a write is answered `To run this: <chat form>` and nothing is invoked; the paste is the confirmation, and it is stateless"): *a routed write on a chat surface is offered as one click showing the full bound line, and where no click can render the door refuses by name; the paste is no longer a confirmation on any chat surface, and the front door still writes nothing from prose — the click is the person's act.*
- **[Record 0044](0044-a-routed-write-is-confirmed-in-proportion-to-its-blast-radius.md)** (the hand-back as the fallback: a channel without `offer`, or a store unreachable at mint, "is answered `To run this: <chat form>` byte for byte"): *without the click the write does not run and the refusal names why — the store could not be reached, or this surface shows no confirmation — and the person's next message re-asks the door; the graded ladder and the store are unchanged and become the one offer path every caller mints through.*
- **[Record 0054](0054-a-refusal-the-person-caused-is-one-question-with-a-best-guess.md)** (every refusal rendered through the seam, the cause deciding the reply): *a disagreement between the door's own models is not a refusal the person caused and is never rendered: it floors to the route, which runs the request; 0054's question with a best guess is reserved for what only the person can decide, and a refusal's text is carried whole under the reason cap, never cut at a quote or a bracket.*
- **[Record 0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md)** ("a bind at or after the path's confirm class is handed back as the line to paste"; the verifier's disagreement "hands the line back to type"): *a bind at or after the path's confirm class is offered as one click through record 0044's store on every chat surface, and a verifier disagreement or failure floors to the route; the operator outranks no guard, deterministic code still authorizes, fences and executes — and it also never interprets a failure into a sentence: no path after the operator's decision renders a line to retype.*

## Why not X

**Why not keep fixing each site?** The day produced fourteen defects and five fixes, each correct and each local; the survey shows eight render sites and three decide sites still standing after them. A rule enforced in eleven places is not a rule; the fifteenth defect lands at whichever site the sixteenth patch misses. The table makes the next defect a missing cell — a compile error or a failing table test — not a production incident.

**Why not let the operator render the outcome too?** Record 0057's split is the reason the door works at all: judgement in the model, determinism at the boundaries. Rendering is execution; an execution the model words is an interpretation of its own decision, which is the two-interpreters problem again from the other side.

**Why not floor to a question instead of the route?** A question spends the person's attention on the system's failure, which is record 0067's "never a refusal shown to the person" inverted. The route is a floor that acts: it runs the request with the reading the product shipped with, and the person corrects a wrong run — visible, steerable, stoppable — rather than answering for a parse.

**Why not delete the hand-back on typed surfaces too?** A terminal's native act is typing; naming the exact line there is the refusal's way forward, not a broken button. The guarantee is scoped to chat, where a rendered line to retype is a button that does not press itself.

## Boundaries

Not changed: the class ladder and `blastRadius` over parsed input, the authorization table, the seam's parsers and retry bound (record 0067), the intake gate (record 0058), admission's owner store and the durable inbox, the confirm store's invariants (one row per thread, consume-once, requester-bound). Not owned here: the confirm default's level (the narrowed U16's gates), plan 002's memory, briefs and image units, and the plane's queue (record 0064) — the table decides a bind's outcome, never its admission to capacity. Compatibility: a deployment sees fewer dead ends and no new surface; `routing.operator: off` remains the rollback lever, and under it the route stage asks the same table.

## What would change our mind

- *The click is friction the text was not.* If the confirmation rows' consumption rate says people abandon clicks where they used to paste (measured on the store's consume-vs-expire counts after one week), the write row's chat cell is re-argued by amendment — the table stays, the cell moves.
- *The route floor loops or surprises.* If floored requests re-enter the operator through any path, or the route's reading of a floored request starts writes the person then reverts, the floor narrows to read-only presets by amendment and the rest becomes a named refusal.

## Rollout

One plan, [docs/plans/2026-09-20-001-feat-one-execution-path-plan.md](../plans/2026-09-20-001-feat-one-execution-path-plan.md), in the same pull request as this record: the fourteen fixtures first, the table as a pure refactor second, then one cell per unit in the order that keeps production green — the click, the verifier floor, the bind repairs, the owner rule, the typed line, and the hand-back's retirement last, when nothing renders it. Every criterion is bound to a test id and each defect's fixture names the unit that turns it green.

## Sources

Records [0039](0039-the-front-door-writes-nothing-from-prose-and-never-routes-twice.md), [0044](0044-a-routed-write-is-confirmed-in-proportion-to-its-blast-radius.md), [0054](0054-a-refusal-the-person-caused-is-one-question-with-a-best-guess.md), [0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md) and [0067](0067-one-seam-for-a-structured-answer-a-violation-is-re-asked-with-the-violation-named-and-the-callers-declared-floor-holds-never-a-refusal-shown-to-the-person.md); [docs/plans/2026-09-18-002-feat-the-operator-is-the-one-door-plan.md](../plans/2026-09-18-002-feat-the-operator-is-the-one-door-plan.md); issues 1993, 2010 and 2025 and the fixes they drew; [docs/reference/specs/routing-and-config.md](../reference/specs/routing-and-config.md) items 21, 25 and 29; the survey above, verified at `b19caf8a`.
