---
title: The front door writes nothing from prose and never routes twice; a routed write is handed back by its effect, a failed command asks
status: accepted
date: 2026-09-15
pattern: Fail-stop over fallback; a decision derived from a field the definition already carries, never a hand-kept list
---

# The front door writes nothing from prose and never routes twice; a routed write is handed back by its effect, a failed command asks

**The ask.** Decided by the maintainer on 2026-09-15, before the commands half of [record 0036](0036-one-front-door-the-router-offers-every-command-and-ship.md) is built: two paragraphs of that record's "Commands at the front door" section change. Record 0036 is accepted and stays so; a record is never edited, so this one carries the change and names exactly what it replaces. Written for the engineer implementing the commands plan (`docs/plans/2026-09-15-002`).

Success criteria: (1) no command with `effect: write` is ever invoked by the route stage, whatever the model binds; (2) a routed command that cannot serve produces one reply and no second model decision; (3) nothing is listed by hand: a write command added tomorrow is handed back the day it lands.

## TL;DR

Record 0036 had the door run routed writes at once with a receipt line, keep five hand-picked commands out by a flag, and, when a routed command answered not found or unavailable, ask the router a second time over the presets. The maintainer's direction: no command may write unintentionally, and a second guess stacked on a failed first one is fragile. So the door hands back every `effect: write` command as the exact line to paste and runs every `effect: read` at once, and a failed command replies its own error line and the override footer, then stops; the person's next message is the follow-up. The cost is one paste per routed write. The `handBack` flag, the five-command list and the re-route are not built.

## What changes in record 0036, and why the acceptance still holds

Record 0036 was accepted on three grounds for the commands half: the menu is derived from the command definitions, a routed command runs through the registry's one `invoke`, and the door adds no state. Its "Which writes run at once" paragraph rested on a fourth: the precedent of routed coding, where a wrong route costs a pull request. That precedent does not carry. A wrong coding route leaves a branch to delete; a wrong `mcp add` or `config set` changes what every later run in the channel does, and the receipt line only tells the person after the fact.

**Handed back by effect.** `CommandDef.effect` is `read` or `write` on every command today (record 0008). `routeRequest` reads it after the bind and before `invoke`: a write is answered `To run this: <chat form>` and nothing is invoked; a read runs. The paste is the confirmation, and it is stateless: the typed grammar runs the pasted line, authorizes it, records it and audits it exactly as a typed command. The three grounds hold: the menu is still derived, the invoke path is unchanged, and no state is added. The `handBack` flag and the five-command list of record 0036 are not built; `effect` already says it.

**A failed command asks.** Record 0036's "the re-route" paragraph carried the regex path's fall-through forward: a routed command that answered not found or unavailable was re-routed once over the preset table. That is a second model decision made on the back of a failed first one, and once `ship` is the table's write preset it could turn "run the tests on main" on a repository with no resident into a pipeline. Instead the stage replies the receipt, the command's own error line (`repo test` already says "`acme/api` is not onboarded, `repo onboard acme/api` first"), and the override footer (`reply agent:<preset> to run it another way`), seals the inline run with the command's own `ok`, and stops. The person decides; the router runs fresh on whatever they say next. This is the same shape a routed card already has on every close.

**Generalized.** The door never chains a decision. Every outcome of a routed command is one reply: success carries the receipt and the command's text; anything else carries the receipt, the command's own line and the footer. Every write is a hand-back. Every read runs. Those three sentences replace the two paragraphs.

## Boundaries

Not here: a stateful "reply yes" confirmation (the paste needs no pending state); a per-command opt-in that lets a write run at once from prose, until a month of hand-backs says which writes deserve it (`config.set` is the candidate); any change to the ship half of record 0036 or its plan. The regex path is still deleted, on the commands plan's gate.

## Validation

The commands plan (`docs/plans/2026-09-15-002-feat-commands-through-the-front-door-plan.md`) binds the criteria: every `effect: write` command in the full-capability catalogue is handed back by an enumeration test and none reaches `invoke`; a scripted `not_found` from a read command yields one reply with the receipt, the command's line and the footer, and no second route; the live receipt for a routed write is the hand-back line and the override visible only after the paste.

## Sources

- The maintainer's direction, 2026-09-15: "drop the regex fallthrough entirely, it seems relatively fragile … message the user and ask for follow up input … we definitely also don't want any command to unintentionally write."
- [0036](0036-one-front-door-the-router-offers-every-command-and-ship.md) (the paragraphs replaced), [0008](0008-one-command-definition-every-surface.md) (`effect` on every command), [0026](0026-capability-profiles-and-request-routing.md) (the override footer's origin).
