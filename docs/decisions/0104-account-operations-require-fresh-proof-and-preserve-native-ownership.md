---
title: Account operations require fresh proof and preserve native ownership
status: accepted
date: 2026-10-10
pattern: Operation-bound dual authentication with independent native authority
---

# Account operations require fresh proof and preserve native ownership

## Context

The approved browser plan requires link, unlink and recovery in the first release.
Each operation has a new ten-minute, single-use challenge for both accounts.
Recovery also requires the existing identity administrator permission. Proposed
record 0081 instead deferred recovery and required additional operators later.
This record resolves that conflict in favor of the approved browser plan.

## Decision

Reuse the existing account ceremony and atomic directory transaction. Bind each
challenge to its organization, initiating signed account, target provider and
intended operation. Store only challenge digests. Require fresh control of both
accounts and confirmation by the initiating account before committing. Consume
the operation, binding changes, audit outcome and two addressed notices together.

Recovery additionally checks current `identity:write` permission against the
exact proved target account. It can restore only that account's existing person.
Different-person reassignment and person or history merges remain conflicts.
An email match, service credential, view-as session or old proof grants no link.

A directory tombstone ends the joined relationship. It does not revoke an
account's independent native permissions. Freshly authenticated sources retain
only their own history and current source partition. Any prior partition is
derived inside the store from the current tombstone; a client cannot select it.
Historical actors, receipts, unit owners and effect owners stay unchanged.
Restoring an exact owned unit for reading grants no old input, history, reply,
execution or provider-resume capability. Mixed prior owners remain fenced.

A protected personal device approval is standing delegation, scoped to its exact
account, organization, issuer and application. Its credential and user's current
permissions must both pass. Revocation or a changed installation pin closes it.
It supplies no signed browser session or fresh account-operation proof. Before
linking, a delegated service has only its own native private stream.

Slack notices use durable addressed outbox rows and stable delivery identifiers.
The host checks the current native recipient before delivery. Failed notices
remain pending across restart. Signed browser account reads and protected notice
acknowledgments remain available when Slack sign-in setup is unavailable; binding
changes still require both configured proof providers.

## Evidence and boundary

The person-directory, account-link-consent, organization-orchestration and browser
specs carry the behavioral proofs. Both store implementations must preserve
source attribution, exact retry receipts and former-peer exclusion. Current proof
providers support Access and Slack; another provider needs its own verified
adapter before account mutations become available there.

Source tests do not establish physical notice delivery or staging acceptance.
Configuration, credentials, deployment and live acceptance require their own
receipts. The frontend cutover separately retires the old email bridge.
