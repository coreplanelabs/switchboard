---
title: Replace the browser interface and add organization orchestration
type: feat
date: 2026-10-10
status: proposed
---

# Replace the browser interface and add organization orchestration

## Outcome

Home answers what needs the requester, what is moving and what is waiting.
The browser presents durable pipelines and units, their threads and their run
evidence. One logical organization orchestrator orders shared acts while each
person reads only messages addressed to them. Every act keeps its authenticated
source and uses the existing dispatcher, policy table and unit owner.

Build the replacement beside the current frontend. Use the existing component
system and the sibling console's typography, neutral surfaces, green accent,
compact spacing and responsive sidebar. Support light, dark and system themes.
Remove the old presentation only at verified cutover.

## Sources

This succeeds the Browser Home plan dated September 24. That source contains
67 requirements, nine flows and twenty acceptance examples. Its core thesis
remains: attention first, pipelines for shared work, threads for conversation,
and runs for evidence. Its organization backend was a separate prerequisite;
this delivery includes that prerequisite.

The comparison baseline is source commit `0386aa2c28a82a27d22164e93de44edd0a0db7ac`
and the release candidate read on October 10. Record 0097's corrected metrics
contract and the independent metrics dashboard remain separate source work.
The replacement retains `/metrics` for that dashboard's final port.

## Adversarial findings and disposition

| Finding | Required change |
| --- | --- |
| Recent runs cannot enumerate old unresolved work | Page the durable pipeline inventory, with an insertion watermark. Never infer completeness from the plane's recent-run table. |
| Identity proof modules exist but production still links by email | Reuse the proof directory and two-sided ceremony. Fence every binding-dependent read and act against the authoritative revision. No email-based join into a private stream. |
| Browser sends currently refuse foreign threads | Add an attributed, authorized destination path. Preserve the actual browser requester; never impersonate the origin adapter. Separate acceptance from adapter delivery. |
| Current authorization has no organization axis | Bind one explicit installation organization at authenticated ingress, before entity authorization. Partition private state by it. A browser cannot choose a tenant. |
| Private units deliberately redact their implementation fields | Use existing sanitized unit and pipeline projections. Do not expose work briefs, private worker addresses, source quotes or hidden counts. |
| There is no general assigned condition | Persist explicit condition ownership and revision. Only a condition assigned to the current person enters Needs you. Missing ownership remains unknown. |
| Current units retain seeded-plan sequencing | Present durable work independently of process shape without claiming the execution graph has retired. |
| Remote live runs have no local token | Preserve the authenticated remote stream, current live state and activity. Missing local capability is not completion. |
| Command confirmation is changing independently | Port the saved confirmation identity and response actions at integration. Do not create a second confirmation store. |
| Metrics row schema is changing independently | Keep the route and shared chart primitives. Port Usage and System health once the original writer's reviewed contract is available. |

## Vocabulary and information architecture

| Surface or concept | Meaning and navigation |
| --- | --- |
| Home | Shared authorized attention plus the requester's private broad stream. |
| Pipeline | One durable execution, linked to its asking thread. Shows units and plan provenance; has no separate composer. |
| Unit | One deliverable, canonical thread, branch, rounds and pull request. Remains visible while unresolved, even without a live run. |
| Thread | A request and its replies. It can exist outside a pipeline. |
| Round | One pass over a unit; coding, review and findings yield child runs, while merge waits on its guards. |
| Run | One piece of evidence, with authoritative live state and outcome. Generic parent-run ancestry remains distinct from pipeline ancestry. |
| Plan | Context with a human provider address. A parent issue is not execution parentage. Legacy source records must be identified accurately. |
| Pull request | Evidence attached to a unit, opened in the main-pane diff viewer. |
| Settings | Runtime, proved identities, existing connections, channel settings and installation configuration. |

Use the vocabulary's twelve nouns. Agent names are secondary metadata, not
navigation. Display code for the coding pass. Internal identity, scheduler and
storage terms stay out of product labels.

Primary navigation is Home, Delivery, Costs and Metrics. Run details remains a
contextual destination with an advanced global index. Runtime moves into
Settings only when its old list/detail/feed and management behavior have parity.
Preserve authorized `/runs/<id>`, `/runs/unit/<key>` and `/threads/<key>` links.
At cutover `/`, `/plane` and the old thread discovery entry converge on Home.

## Backend contract

1. Resolve organization and source identity from authenticated installation
   configuration. Preserve human, service and verified on-behalf-of attribution.
   Identity binding joins private streams, never creates authority.
2. Store versioned organization state, wake sequence, projection revision and a
   fenced reconciliation lease. Model runs can change without changing the
   organization's logical identity.
3. Keep private message content separate from shared work facts and non-content
   receipts. Use the same authoritative database for binding revisions and
   binding-dependent admission; an old relationship cannot survive revocation.
4. Scope replay keys by organization, source and authenticated identity. The
   same key and payload returns its original receipt. Changed payload refuses.
   Compare shared acts against their observed durable revision before effects.
5. Use the existing dispatcher and original unit effect/answer owner. An
   organization reservation cannot authorize a second execution or replace a
   unit's pending-question fence. Unknown effects remain unknown after restart.
6. Bound admission by actor, source, workload and organization. Reserve capacity
   for reconciliation. Throttling starts no act. Retention and deletion remove
   content while retaining bounded non-content replay protection.
7. Enumerate all authorized unresolved units from durable inventory, independently
   of recent run history. Complete, partial, unavailable and filtered projections
   are distinct. Completed history has its own cursor.

## Browser contract

The server owns every seed, identity, destination permission and stream frame.
The client owns presentation state. The writable dock is broad or explicitly
focused on one authorized local thread. Navigation, entity changes, back/forward,
reload or revocation exit focus. Exactly one composer is mounted. Drafts and
context are keyed by organization, person and destination. Context attachments
are removable untrusted references; they never choose identity or authority.

Use the same content order from 320 CSS pixels through desktop. Virtualize at
least 1,000 unresolved units in one logical list. Do not hide fields through
horizontal clipping. Preserve visible focus, keyboard order, semantic labels,
destination announcements, usable touch controls and reduced motion. State and
attention must remain understandable without color.

## Delivery stack

1. Durable inventory and sanitized Home projections, with exact behavioral proofs.
2. Organization state, identity directory integration, replay receipts and private
   streams, tested against memory and SQLite implementations.
3. Authenticated adapters and original-owner effect integration, with refusal,
   revocation, retry and restart proofs.
4. New frontend entry, shell, pages and destination dock alongside the old entry.
   Preserve complex transcript, diff and chart renderers as shared primitives.
5. Port the independent metrics dashboard and command-confirmation changes;
   verify the combined head, then cut over routes and remove the old frontend.

Each change is a small dependent pull request with clean linear commits and a
plain-language description. Review the exact current head, address each finding
and wait for its required checks. Stage the combined candidate through the
existing serialized staging controller. Production merge/release/deployment
remain outside this task.

## Verification

| User outcome | Required evidence |
| --- | --- |
| Aged work remains visible | A pipeline with no recent run survives inventory paging and appears unresolved. |
| Unknown or denied work does not leak | Direct reads and feeds refuse alike; no private fields or hidden row counts appear. |
| Attention identifies the right person | Exact condition assignment is urgent; attribution, unknown ownership and another person's wait are not. |
| Repeated or competing answers start once | Same-key replay returns the same receipt; changed payload and stale revision produce no effect. |
| Private streams remain private | Independent actors, source revocation and binding changes remove future access and close feeds. |
| The dock has one clear destination | Explicit focus, route changes, reload, storage denial and keyboard operation preserve one composer and separate drafts. |
| Existing functions survive | Live remote activity, run actions, confirmations, unit evidence, diffs, runtime feeds, costs, delivery and settings pass their user paths. |
| Layout and themes work | Desktop and phone browser receipts in light/dark/system; persistence, touch, focus and no horizontal loss. |
| Source is reviewable | Required fix/gates, exact-head review and green CI for each stack member. |
| Staging works end to end | Exact deployed head, authenticated browser flows, agent run and follow-up, restart, real repository work and review on disposable fixtures. |

Run focused tests by exact filenames before push, then repository-required
verification. Generate screenshots through the existing capture machinery.
Measure first attention and complete-list performance before claiming the old
plan's latency budgets. A fixture or health response cannot establish live
organization behavior.

## Design decision held before cutover

The old plan's pinned plan-digest pipeline and per-unit multi-repository execution
do not exist in the current source model. Adding them changes the execution
engine, not just organization orchestration or frontend presentation. Finish
independent work first, then obtain the scope decision before cutover: retain
truthful legacy execution support while the pinned-plan migration stays separate,
or add that migration to this stack. Do not invent digest or repository fields,
erase legacy work or declare those requirements satisfied by presentation alone.
