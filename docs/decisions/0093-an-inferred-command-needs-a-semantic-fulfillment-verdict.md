---
title: An inferred command needs a semantic fulfillment verdict
status: accepted
date: 2026-10-07
pattern: One bounded interpreter with a separate admissibility judgment
---

# An inferred command needs a semantic fulfillment verdict

A command's read/write class does not establish that it fulfills the current
request. Repository discovery can prepare a correction without performing it.
A requester-owned issue checkpoint establishes a target, not permission or
current write intent. Neither a keyword nor a command's reason closes that gap.

## Decision

Before accepting an inferred terminal registry invocation on an unowned chat
turn, the operator asks its same configured `RouteModel` whether the complete
typed invocation fulfills the whole current request. The checker receives the
original current text, earlier turns stamped with that requester and an
available requester-owned checkpoint. Other actors, unattributed turns and
assistant reports cannot become requester evidence. They remain contextual
data in the original routing prompt.

The verdict has exactly `agrees` and a nonempty bounded `reason` on the forced
`verify` tool. Runtime parsing rejects absent, malformed, inherited, extra-field
and no-call results. The checker cannot choose a route, repository, preset or
new command, rewrite text, grant permission, execute a tool or claim completion.
A positive result permits semantic acceptance only. Existing resolved-actor
authorization, ownership, targets, exact heads, confirmation and effects remain
their original owners' decisions.

Every verdict consumes a slot from the existing four-read allowance before its
model call. Grounding and verification compete for that allowance; proposal or
repair turns cannot replenish it. The same timeout signal, elapsed deadline,
output allowance and structured repair count cover the whole operation. A false
or unknown verdict uses an existing repair slot or ends without a terminal
command. Errors, exhausted allowance and late verdicts cannot become acceptance.
The exhausted multi-call extraction path applies the same check without a new
repair budget. Proposal and verdict attempts are recorded separately; all model
usage rides the same provider accounting. Valid inferred commands therefore
cost an additional model call, not an unchanged cost claim.

Presets, helper reads, owned-thread folding and CLI/HTTP/MCP explicit machine
commands retain their paths. The old load/replay verifier and its default parser
keep their separate contract. A natural catalog question can validly complete
as a listing; a listing used to discover a repository for a requested correction
cannot complete that correction.

## Narrow amendment

This amends the no-second-judgment premise of [record 0069](0069-the-one-door-has-one-execution-path-a-bind-runs-clicks-or-routes-a-violation-is-re-asked-a-disagreement-floors-and-no-chat-surface-hands-back-a-line-to-retype.md)
and routing-and-config item 25. The operator remains the sole route chooser and
the execution table remains the sole execution path. Rejection returns to that
same bounded loop; it does not introduce another dispatcher, classifier,
controller or default route. The original record remains immutable.

## Proof and limits

The routing spec names the exact correction/listing counterfactual, natural
catalog positives with issue context, foreign-source exclusions, strict shape,
normal and exhausted paths, timeout/abort/errors and shared-read exhaustion.
Those scripted tests prove enforcement, not a model's semantic accuracy.
A containing release must still pass its ordinary candidate gate. False positive
or negative judgments and added latency remain live qualification obligations;
no regex, self-declared purpose or target checkpoint replaces that evidence.
