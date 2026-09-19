---
title: One seam for a structured answer — a model asked for one structured answer is forced onto its tool, the caller's pure parser accepts or names the violation, a violation is re-asked with the violation named, and after bounded retries the caller's declared floor holds, never a refusal shown to the person
status: proposed
date: 2026-09-19
pattern: Parse, don't validate (a pure parser per caller returns the value or names the violation); retry with feedback (the violation quoted back to the same model as a user turn), bounded by a named constant with every attempt on the record; a declared floor per caller as the null object — the seam degrades to it, never to an error a person reads
---

# One seam for a structured answer: a violation is re-asked with the violation named, and the caller's declared floor holds, never a refusal shown to the person

**The ask.** Decide (the maintainer, before the one-door plan's U19 is seeded): every place the product asks a model for one structured answer goes through one seam — the tool forced, the caller's pure parser accepting or naming the violation, a named violation re-asked of the same model with the violation as a user turn, at most two retries, every attempt recorded on the caller's event — and after the retries the caller's declared floor holds, never a refusal shown to the person. Written for an engineer who knows the route stage, the operator and the intake gate. Success criteria:

1. One module owns the ask-parse-re-ask-floor loop; the four callers (the route tool, the verifier, the operator, the intake gate) hold only their prompt, their parser and their floor.
2. A violation — prose that is not one JSON object, a call to another tool, a missing or malformed field — is re-asked of the same model with the violation named in a user turn ("your answer was not a decision: \<why\>; answer with the decision tool only"), at most twice; the third violation is the floor.
3. Every attempt — the violation it named or the acceptance — is on the caller's event, so a flaky model is legible on the record as re-asks, not as silent floors.
4. No path renders a parse failure to the person: the operator's floor is the readers' route with reason `non_decision`; the other three floors are unchanged (the default agent, disagree, silent).
5. The two `src/cli.ask.test.ts` process tests pass through the floor unchanged — the CLI's answer never depends on a model's first answer being well-formed.

## TL;DR

Four callers ask a model for one structured answer through the same production seam (`providerRouteModel`) and each hand-rolls the same gate — not a single JSON object, wrong tool, missing field — without ever re-asking: one malformed answer and the caller falls straight to its floor, and until pull request 1988 the operator's floor was a refusal sentence shown to the person. The model is sitting right there, the violation is already named in the parser's own words, and nothing asks it to try again. The bet: one seam. Force the tool; the caller's pure parser accepts or names the violation; a violation is re-asked of the same model with the violation as a user turn, at most two retries, every attempt on the caller's event; after the retries the caller's declared floor holds — never a refusal to the person. The four callers migrate onto it, floors unchanged except the operator's, whose pull-request-1988 interim fallback (the readers' route, reason `non_decision`) becomes the seam's declared floor. It costs one module, four call-site migrations and scripted-model tests. Doing nothing leaves four copies of the gate to drift apart — the operator's copy already shipped a person-facing refusal once — and every future structured ask (a fifth caller is a matter of time) hand-rolls a fifth.

## Today at `c5542043`

Every claim verified at head.

| Claim | Proof at `c5542043` |
| --- | --- |
| Four callers ask a model for one structured answer through `providerRouteModel` | `src/core/dispatch/route.ts` line 1044 (the seam: one completion, the prompt's one tool forced by name — `toolChoice: { type: "tool", name }` — a text answer handed to the same parse); built for the route stage at `route.ts` line 1221, for the operator at `src/core/dispatch/operator.ts` line 516, for the verifier at `operator.ts` line 608, for the intake gate at `src/index.ts` line 703 |
| Each caller hand-rolls the same gate — not a single JSON object, wrong tool, missing field — and never re-asks | `parseRouteAnswer` (`route.ts` line 842: `not a single JSON object`, `missing preset`, `missing reason`), `parseVerifierAnswer` (`route.ts` line 800: the same three refusals plus `agrees is not a boolean`), `parseOperatorDecision` (`operator.ts` line 264: the same, plus the mixed-shape refusal), `parseIntakeAnswer` (`src/core/intake.ts` line 196: the same, plus the enum check); no caller loops — each parse failure falls to the floor in one step |
| The route tool's floor is the default agent | `route()` (`route.ts` line 938) answers `preset: undefined` with the reason, and the dispatcher runs the request on `defaults.agent` (`src/core/dispatcher.ts`, the route stage's "fell to" comment near line 703) |
| The verifier's floor is disagree, fail closed | `verifyOperatorBind` (`operator.ts` line 575): a throw or timeout is `{ agrees: false }` naming the failure; `parseVerifierAnswer` refuses everything else as a disagreement that says what came back — "never a silent agreement" |
| The operator's floor was a refusal shown to the person, until pull request 1988 patched the interim fallback | `parseOperatorDecision` marks its own refusals `fallback: true` (`operator.ts` lines 264 to 271; `runOperator`'s catch at line 382 the same) and the dispatcher, under `on`, falls back to the readers' route for a marked refusal instead of rendering it (`dispatcher.ts` lines 616 to 628, the "non-decision" comment) — the interim shape this record replaces with the seam |
| The intake gate's floor is silent | `parseIntakeAnswer` (`intake.ts` line 196): another tool, prose, an answer outside the enum are all `verdict: silent` with `source: error`; `decideIntake`'s catch (line 182) fails a timeout or provider error closed the same way |
| Not on the seam: the review verdict parser | `parseVerdictInput` (`src/core/reviewVerdict.ts` line 148) validates an in-run tool call the agent makes from inside its own loop — the harness's tool-result channel already carries the violation back to the model, which is exactly the re-ask this record builds for one-shot calls |
| Not on the seam: the ship plan parsers | `parsePlanUnit` and its siblings (`src/core/ship/contract.ts`) read a plan's markdown — a document, not a model's answer to a forced call; there is no model on the line to re-ask |

## The shape

One module, `src/core/dispatch/structured.ts` (the plan's U19 names the files), owning the loop the four callers each approximate today:

- **Force the tool.** The ask rides `providerRouteModel` as today: the prompt's one tool forced by name, a text answer handed to the same parse — the text contract stays the escape hatch for a provider that cannot take a forced call.
- **The caller's parser is pure and total.** Each caller hands the seam its existing parser, reshaped to one contract: the answer in, either the accepted value or the violation named in one line — exactly the sentences the four parsers already produce (`not a single JSON object: …`, `the operator called tool "x", not decision`, `missing preset in the router's answer: …`). The parsers do not move; the loop around them does.
- **A violation is re-asked, the violation named.** The seam appends the model's answer and one user turn — "your answer was not a decision: \<why\>; answer with the decision tool only" (each caller's noun and tool name interpolated) — and asks the same model again. At most two retries, the bound a named constant in `src/core/budgets.ts`; the timeout is the caller's, covering the whole loop, so a re-ask never spends time the caller did not budget.
- **Every attempt is on the caller's event.** The route decision, the `operator` event (run-history item 60), the verifier's line and the intake receipt each gain the attempt list: what each answer violated, or that it was accepted, so a model that needs two asks is visible on the record and the replay can count re-asks.
- **After the retries, the caller's declared floor holds.** The floor is data the caller declares, not a branch the caller writes: the route tool falls to the default agent with the last violation as the reason; the verifier disagrees naming it; the operator falls to the readers' route with reason `non_decision` — pull request 1988's shape-A fallback code collapsed into the seam, the `fallback: true` mark retired with it; the intake gate is silent with `source: error`. **Never a refusal shown to the person**: a parse failure is the system's problem, and the person sees the floor's behavior, not the seam's plumbing. A model-authored refusal — the operator deciding `refusal` as a real decision — is not a violation and renders as today.

Timeouts and transport failures stay what they are: fail-closed floors without a re-ask (there is no answer to quote back, and the budget is spent); only a parsed violation earns one.

## One trace: the operator answers prose, twice

The hard case is the one pull request 1988 patched: the strong-tier operator, asked for one decision, answers a paragraph.

1. A member types "ship the intake fix" in a thread. The operator's turn is asked through the seam: the decision tool forced, the projection, the tail, the request.
2. The model answers prose — "I'll route this to the ship agent since…". Today: `parseOperatorDecision` refuses it (`not a single JSON object`), the refusal carries `fallback: true`, and the dispatcher silently runs the readers' route; before pull request 1988 the person read "the operator's answer was not a decision: …". After: the seam re-asks — the prose quoted back, "your answer was not a decision: not a single JSON object: I'll route this…; answer with the decision tool only" — attempt one recorded on the event.
3. The model calls the wrong tool. The seam re-asks once more, the violation naming the tool it called and the one it must call — attempt two recorded.
4. The model calls the decision tool with one bind. The parse accepts; the bind runs through the registry exactly as a first-ask decision would; the event carries three attempts, two violations named.
5. Had the third answer violated too, the floor: the readers' route runs, reason `non_decision`, the three attempts on the event beside what then ran — and the person reads the routed run's ordinary card, never a sentence about parsing.

The property: the person's experience is decided by the caller's floor, the model's flakiness is legible on the record, and no caller ever again ships the choice pull request 1988 had to patch.

## The difficulty map

1. **The event shape** (most work): four callers record on four different events (the route decision, the `operator` event, the verifier's receipt line, the intake receipt), and the attempt list must land on each without breaking run-history item 60's consumers or the replay's counters.
2. **The migration without behavior drift**: the four floors must come out byte-equivalent for the no-violation and the exhausted case — the two `src/cli.ask.test.ts` process tests are the canary, passing through the floor unchanged.
3. **Budget arithmetic**: three model calls under the caller's one timeout; the retry bound and the per-ask share must keep the operator's median-latency receipt honest.
4. **The re-ask prompt**: one sentence per caller, the violation interpolated — kept short enough that a re-ask hits the prompt cache for everything but the two new turns.

## Why not X

**Why not raise each parser's tolerance instead (accept prose that contains the JSON, guess the missing field)?** That is validation sliding toward guessing; `parseRouteAnswer`'s compound-inference comment shows how narrow a safe inference has to be. The re-ask keeps the parsers strict and puts the flexibility where it belongs — in the model's second try.

**Why not retry inside `providerRouteModel`?** The transport seam cannot name a violation: only the caller's parser knows what a decision is. The loop needs the parser, so it lives above the transport and below the callers.

**Why not put the review verdict and the plan parsers on the seam too?** The verdict parser is an in-run tool: the harness already hands the violation back to the model as a tool result, which is this record's loop in its native habitat. The plan parsers read markdown a person or a run wrote; there is no forced call and no model waiting to be re-asked.

## Boundaries

Not changed: the four prompts, the four parsers' rules, the four floors' behavior (except the operator's, which trades the interim `fallback: true` mark for the declared floor), the class ladder and every guard downstream of an accepted answer — the seam re-asks for shape, never for content, and outranks nothing. Not owned here: [record 0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md)'s decision shapes and [record 0058](0058-a-thread-reply-is-read-before-it-is-answered-intake-decides-whether-the-bot-was-addressed.md)'s verdict semantics — this record moves how their answers are obtained, not what they mean. Compatibility: a deployment sees fewer floors and no new surface; the event's attempt list is additive.

## What would change our mind

- *The re-ask does not pay.* If the replay shows violations that a re-ask rarely repairs (the model repeats the same shape), the bound drops to one or zero by amendment and the seam remains the one place the gate lives.
- *A caller needs a floor the seam cannot express.* If a fifth caller's floor is not a value but a control-flow escape, the seam's contract widens by amendment rather than the caller hand-rolling the loop again.

## Rollout

One unit, U19 "One seam for a structured answer", appended to the one-door plan ([docs/plans/2026-09-18-002-feat-the-operator-is-the-one-door-plan.md](../plans/2026-09-18-002-feat-the-operator-is-the-one-door-plan.md)) in the same pull request as this record: the seam module and its scripted-model tests (wrong-then-right, always-wrong, right-first, each attempt on the event), the four callers migrated with pull request 1988's shape-A fallback collapsed into the seam, the two `src/cli.ask.test.ts` tests passing through the floor, and the spec rows — routing-and-config items 21, 25 and 29 and the intake item's model call (item 27) — moved in the same pull request. U19 depends on U17 (the default is on; its interim fallback is what U19 collapses) and no other unit depends on it; U17's section takes a dated amendment note naming the interim.

## Sources

Records [0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md) and [0058](0058-a-thread-reply-is-read-before-it-is-answered-intake-decides-whether-the-bot-was-addressed.md); [docs/reference/specs/routing-and-config.md](../reference/specs/routing-and-config.md) items 21, 25, 27 and 29; pull request 1988 (the operator-on default and the interim fallback); the survey above, verified at `c5542043`.

## Amended 2026-09-19 — issue 1993: the operator's violation set gains the binds production actually produced

Production evidence (issue 1993): under `routing.operator: on`, the operator bound every plain-words coding ask to a ship line without the person's words — bare `ship`, or flags in place of the person's text — and every preset bind was handed back as a line to type; after pull request 1996 taught the door to route a preset bind on the person's own request, the verifier refused the preset line for a fix ask, so the asks still dead-ended. The seam's violation set for the operator therefore widens beyond shape: a bound line the registry cannot parse (no listed command, no preset, no steer) and a preset bind that drops the request's own words — a paraphrase or flags in place of the person's text — are violations too (`OperatorBindGuard` in `src/core/dispatch/operator.ts`, judged over the raw line before the receipt cut), each re-asked with the violation named and, after the bounded retries, floored to the readers' route with reason `non_decision`, never a dead hand-back the person must retype. The parsers stay strict and the guard reads only the projection's preset names, the request and the registry's parse; the floor stays as this record declares it — carried in code as the seam's declared floor the dispatcher reads, never a `fallback: true` literal on the decision.
