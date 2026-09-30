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
