---
title: An explicit PR batch may start exact Ship children
status: accepted
date: 2026-09-29
---

# An explicit PR batch may start exact Ship children

A request such as “ship these” names several existing pull requests, sometimes in different repositories. A single Ship run has one repository and one pull request target. The conductor already coordinates independent review runs, but its blanket ban on write children prevents it from coordinating the same PRs through Ship.

The operator binds an explicit batch of linked PRs to the conductor without a repository target. For a request beginning “ship these” or “ship all of these,” the conductor may spawn Ship only for a pull request URL in that original request. Each spawn's whole prompt is the canonical URL. The spawn stage rejects another PR, extra task text, a conflicting repository, a branch, and a repeated target before opening a thread. It binds the listed PR's repository as the child operation target and omits the parent's conversation seed, so another PR in the batch cannot become the child's target. The child enters Ship's existing-PR review path and passes the ordinary requester, repository, profile, ownership and exact-head gates. Other write presets remain unavailable to spawned children.

This exception is narrower than allowing the conductor to start arbitrary write runs. It lets a person authorize one bounded write pipeline per PR with plain words while retaining each PR's independent owner and durable Ship state. A batch review continues to use read-only review children.

## Amended: Ship units outlive the launch run

A Ship unit can remain live for its full delivery lease. If it inherited the conductor's shorter clock or occupied a read-child slot, a six-PR request could leave later PRs unstarted. An exact-PR Ship child therefore keeps the parent link for history and depth, but takes its own normal Ship lease and does not consume `spawn.maxChildren`. The conductor launches all listed Ship units before waiting. The conductor needs at least four minutes left to launch each unit, including its write-up reserve. Read-only children retain the parent clock and fan-out cap. A Ship child may continue after the conductor reports which units are still running.

## Amended: One-day delivery lease

The conductor and each Ship unit ask for one day by default. A Ship unit permits at most 48 review rounds within that lease. When a configured or scoped lease is shorter, the fork selects the greatest round count that fits its effective minutes; a lease too short for even one round is refused. An explicitly configured round count and wall clock must fit together at config load. The read-child fan-out cap remains separate from independent Ship units.

## Amended 2026-09-30: The operator binds exact targets as data

The operator selects Review or Ship and the exact linked PR destinations in one typed `bind_pr_batch` call. Code validates that each selected URL is a real GitHub PR destination in the request, stores the choice on the conductor run, and checks every Review or Ship child against it before opening a thread. This works when Slack flattens bullets and does not infer intent from list punctuation. A conductor with several linked PRs but no typed batch cannot start Review or Ship children. The requester's text remains the child's context, but it grants no additional PR targets beyond the stored typed choice.

Re-evaluation: the original bounded-write exception still holds because every Ship child must match one stored target and still passes the normal requester, repository, ownership and exact-head gates. The typed binding removes list-layout parsing from the authorization boundary.

## Amended 2026-09-30: Require explicit action and list evidence

The typed choice is a proposal, not sufficient authority: a wrong `ship` choice for a Review request, or a selected URL under “do not ship,” would otherwise pass a presence-only check. A bounded lexical gate accepts one explicit positive `review` or `ship` list and requires the typed action and complete target set to match it. It never infers an action or expands targets. Negated, contextual, postfix or ambiguous prose attached to a list item closes the batch for clarification. The narrow grammar still accepts `re-review these` and `ship all of these`. A bare URL is consumed as one span, so a GitHub-looking suffix after a foreign URL's pipe cannot become separate evidence. Any untyped preset bind with two distinct literal PR links is re-asked before a run starts, even if list validation fails. An explicit `agent:conductor` prefix is removed before validating a typed batch. This keeps ordinary “ship these” and “review these” requests direct while refusing uncertain authority before child launch.

Re-evaluation: the bounded-write exception still holds because the typed choice can only narrow one explicit affirmative list, and every Ship child still passes the existing requester, repository, ownership and exact-head gates. Requests outside the proven list grammar need clarification rather than a speculative child.

## Amended 2026-09-30 — the operator interprets the list

Record 0069's one-interpreter amendment supersedes the interim rule that code parses an affirmative Review or Ship list from chat prose. The operator selects the action and ordered PRs. Its bind carries an exact authored action span and the complete destination-URL span for every selected PR. The deterministic gate checks that the action span names the selected action, each destination is a complete authored URL rather than a suffix inside another URL, each URL resolves to the same canonical PR, and no target repeats. It does not decide which words mean Review or Ship, which links are contextual, or whether a list is complete. The operator asks when those meanings are ambiguous. A conductor with no typed batch cannot launch Review or Ship children; an accepted batch still limits every child to its selected action and exact canonical PR.

Re-evaluation: the bounded Ship exception still holds because child launch remains limited to the operator's durable canonical PR set and every child passes the requester, repository, ownership and exact-head gates. Removing the prose grammar restores record 0069's one-interpreter boundary without widening child authority.

## Amended 2026-10-01: Ship children retain evidence independently of their target

A spawned Ship request captures the parent's structured conversation through the same canonical source checks as a read child. Its admitted units retain an immutable context capsule and bind it to each execution attempt before reading it. This preserves tool results, notes and attachment references across the coordinator boundary. The selected PR remains the typed operation target; inherited text cannot change it or grant another write target. Source access is checked again when the child consumes the capsule.

Re-evaluation: the typed PR batch still determines child authority. Preserving verified evidence removes a lossy handoff without widening the accepted target.
