---
title: Review and release the complete frontend replacement
type: feat
date: 2026-10-11
status: accepted
---

# Review and release the complete frontend replacement

## Outcome and standing

Replace the old frontend with the responsive Home interface and its organization
backend. Preserve the existing execution engine, original work owners and
permission boundaries. This plan succeeds [the replacement plan](2026-10-10-001-feat-browser-replacement-plan.md)
and records the later approved decisions without rewriting that plan's body.

This is the acceptance contract for the full stack review. It does not declare
source, CI, deployment or live behavior complete. A path listed below identifies
what to inspect; it is not a passed test or a live receipt.

## Approved decisions

- Include the organization-orchestrator backend. Use durable organization state,
  explicit identity binding and the existing dispatcher, policy and unit owners.
- Keep the current single-repository pipeline engine. Plan-digest locking and
  per-unit multi-repository execution stay in a separate migration. R26 and R51
  below retain their original wording so these exceptions remain visible; they
  are not claimed as delivered. [Engine decision](../decisions/0102-the-browser-cutover-keeps-the-current-execution-engine.md).
- Build beside the old presentation and remove it at cutover. Preserve shared
  transcript, diff and chart primitives; do not restore retired pages during a rebase.
- Every page defaults to the logged-in person's work. The account menu owns
  the global Person view and privileged Everyone view. A Person view is read-only;
  viewing someone else's data never borrows their execution authority. Remove
  per-page Only mine and Runs-specific impersonation controls.
- Answer assigned questions from Home. Confirmation starts with a button and
  hides text entry behind an explicit alternative. Use a trusted action label,
  such as Merge, when the recorded question supplies it; do not infer destructive
  authority from prose. Preserve the exact original question, owner and receipt.
- Pipeline cards show meaningful attention, next acts and links to asking/unit
  threads, repository, branch, pull request and Changes. Use icons with accessible
  labels and resolve the organization's Slack emoji catalog safely.
- Completed work is a recent relative-time timeline for one Sun–Sat week in the
  displayed timezone. Arrows move between weeks; future weeks are unavailable.
  Use the recorded completion time and bounded history pagination.
- Use the sibling console's typography, neutral surfaces and green accent.
  Support light, dark and System, phone and desktop, keyboard use, focus and
  reduced motion. The production chat header has one clear destination and no
  Preview or world wording. Fixture markers remain explicit in local previews.
- Include Metrics Usage and System health from the existing backend contract.
  Both tabs use the same UTC range and report JSON. Missing populations and
  unavailable data remain explicit; do not invent uptime, errors or durations.
- Preserve original adapter attribution, private-source revocation, unknown
  admission outcomes, deletion and bounded replay protection through every rebase.

## Vocabulary and model boundaries

| Concept | Durable meaning and interface |
|---|---|
| Organization | One authenticated installation boundary; the browser cannot choose a tenant. |
| Person and source actor | A person may link proved surface identities. Original source actors and historical attribution remain unchanged; a link grants no authority. |
| Broad conversation | One private stream of that person's messages to the organization orchestrator and replies addressed to them. Undelegated service actors remain separate. |
| Thread | One durable request/reply destination, including work outside a pipeline. Explicit Reply focus selects its existing destination. |
| Pipeline | One current-engine durable execution linked to its asking thread and plan provenance. It is not a second conversation or a proposed replacement graph. |
| Unit | One deliverable with canonical thread, repository/branch/PR, rounds and unresolved conditions. |
| Round | A pass over a unit that produces child-run evidence and recorded findings. |
| Run | Execution evidence with recorded live state and outcome. Generic parent-run lineage remains available outside pipelines. |
| Condition | A recorded unresolved fact, version, responsible actor/owner class and next act. Only explicit current-person assignment is urgent. |
| Receipt | The original accepted, pending, rejected or throttled disposition for one actor/source/organization/key/payload. It does not prove adapter delivery. |
| Plan and PR | Plan addresses are provenance; PRs are contextual evidence opened in the main-pane diff. Neither changes execution parentage or authority. |
| View scope | Mine, Person or privileged Everyone limits reads. It never changes the resolved sender, grants or source proof. |

Identity binding, source snapshots, replay receipts and private content have
separate lifetimes. Use the configured policy and current proof; no dashboard
field invents a plan digest, repository, completion time, owner or model control.
[Account-operation decision](../decisions/0104-account-operations-require-fresh-proof-and-preserve-native-ownership.md)
requires a fresh two-sided proof for each link, unlink and recovery operation.

## Data lifetimes and deletion

Private content, original source snapshots and non-content replay receipts use
separate configured periods. The installation examples use 90, 30 and 365 days
respectively; verification must inspect the actual policy instead of assuming
these defaults. Source snapshots expire from original admission, not delayed
execution. Completed unit facts have no automatic expiry in this contract, while
the interface shows only the selected week with bounded history reads. Run-log
retention is a separate configured lifetime.

Explicit deletion removes content, derived excerpts, search eligibility and
future model context. A bounded non-content tombstone prevents replay from
recreating an act. Unlink and source revocation stop future projection; current
reads and feeds still need current proof. Historical shared attribution remains
without restoring private content. Metrics expose counts and ages, never proof
material or private message bodies.

## First-release surfaces

| Surface | Intake and personal-stream rule | Unit answer and destination |
|---|---|---|
| Browser | Authenticated person; broad stream is private to the proved actor. | Explicit local focus or Home answer goes to the original unit thread; one composer. |
| Slack | Signed native human identity; joins a person's stream only through an explicit proved link. | Original addressed Slack/unit thread; adapter delivery is recorded separately. |
| GitHub | No general chat intake. Signed App installation and sender facts retain their native attribution. | An authorized bound answer to the original pending unit question; PR conversation and canonical record. |
| CLI | Explicit caller/organization grant; only a proved human binding may join a personal stream. | Existing CLI result stream; no new general unit-answer door. |
| HTTP and MCP | Explicit human or service actor. Undelegated services remain separate. Verified on-behalf-of sources project only through their proved current principal and binding, retain the actual service credential, and obey both permission ceilings. | Caller response and original receipts; no authority borrowed from another adapter. |
| Future adapters | Outside this release until they implement the same identity, organization, destination and authorization contract. | No implicit entry or projection. |

## Original requirements and present disposition

The full original requirement set follows. Later decisions above override the
presentation wording in R20/R66 and the engine portions of R26/R51. Technical
owner classes remain meaningful, but the interface says Moving and Other waits
rather than us or the world. R57 remains an explicit live qualification item.
All other rows are intended behavior to review and prove, not completion claims.

| ID | Original requirement | Disposition and source contract |
|---|---|---|
| R1 | One logical organization-scoped orchestrator receives admitted events and messages from the first-release surface matrix and reconciles one shared fleet. | Required; inspect linked spec. [organization-orchestration](../reference/specs/organization-orchestration.md). |
| R2 | The orchestrator's logical identity and durable work survive process replacement without requiring a permanently running model session. | Required; inspect linked spec. [organization-orchestration](../reference/specs/organization-orchestration.md). |
| R3 | Every admitted message preserves its organization, source, destination, actor, and any verified on-behalf-of relationship. | Required; inspect linked spec. [organization-orchestration](../reference/specs/organization-orchestration.md). |
| R4 | Every resulting read or act is authorized as the preserved actor against the resolved organization and target resource. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R5 | Cross-surface identities join one person's stream only through an explicit trusted binding established by an authorized identity flow; similarity, shared text, or organization membership never links identities. | Required; inspect linked spec. [person-directory](../reference/specs/person-directory.md). |
| R6 | An unlinked human identity remains a separate surface-scoped actor, and a service actor remains a separate service lane unless an explicit on-behalf-of grant applies. | Required; inspect linked spec. [organization-orchestration](../reference/specs/organization-orchestration.md). |
| R7 | Linking or unlinking changes future projection only; it never rewrites the historical actor, authorization record, or attribution of an earlier message. | Required; inspect linked spec. [person-directory](../reference/specs/person-directory.md). |
| R8 | Competing acts on shared work are ordered against durable versions; the accepted act records its actor, while stale or losing acts start nothing and return a receipt naming the current fact. | Required; inspect linked spec. [organization-orchestration](../reference/specs/organization-orchestration.md). |
| R9 | Shared fleet facts expose enough actor attribution and ordering to explain what changed without exposing private conversation text. | Required; inspect linked spec. [organization-orchestration](../reference/specs/organization-orchestration.md). |
| R10 | Every Home projection, search result, live update, direct entity lookup, and attached-context lookup is constrained to the actor's current authorized organization before entity-level authorization is applied. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R11 | Unknown and unauthorized entity identifiers are indistinguishable on browser reads and streams. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R12 | Entering focus, loading a local transcript, sending a message, and resuming a unit each re-authorize the resolved actor against the target thread and resulting act. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R13 | Losing organization or target access closes the affected live feed and removes its transcript and composer without waiting for the next send; the route becomes a permission-safe unavailable state, focus moves to its explanation, and the broad stream returns only if organization access remains. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R14 | Drafts, attached context, focus state, and scroll state are isolated by actor, organization, and destination and become inaccessible on logout or identity change. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R15 | Cross-surface streams store only the content required for durable conversation and receipts, preserve source provenance, and apply redaction before logs or model context. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R16 | Transcript and search reads apply current authorization; source deletion, source-access revocation, retention, and explicit deletion have defined effects before release. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R17 | Attached context, external event payloads, fetched artifacts, provider text, and repository content are untrusted referenced data, not instructions, identity, grants, or authority; their provenance is preserved and their size and placement are bounded before model use. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R18 | Home is the primary browser destination and replaces Plane in primary navigation. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R19 | The first screen answers, in order, what needs the current maintainer, what is moving, and what is waiting without requiring them to ask the orchestrator. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R20 | A durable unresolved condition names who can clear it as **you**, **us**, or **the world** and states the next expected act. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R21 | Conditions waiting on the current maintainer receive the strongest visual priority; machine-owned and external waits remain visible but informational. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R22 | Attention is derived from unresolved work rather than from whether the latest run is live, recently ended, or healthy. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R23 | Home, thread search, and completed-history discovery distinguish empty, loading, permission-filtered, partially unavailable, and fully caught-up states without presenting filtered, missing, or incomplete data as absence or completed work. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R24 | Home surfaces runtime failures that threaten active work even though routine runtime management lives elsewhere. | Required; inspect linked spec. [resident-repos](../reference/specs/resident-repos.md). |
| R25 | Ordinary work is discoverable as asking thread → pipeline → units → unit thread → rounds → child runs. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R26 | A pipeline is the durable execution pinned to one plan digest and is not represented as a DAG. | Approved separate engine migration; retain truthful current behavior. [browser-home](../reference/specs/browser-home.md). |
| R27 | Every unresolved unit remains discoverable in one logical list without page-by-page navigation; virtualization and progressive rendering may preserve performance. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R28 | Completed work is hidden by default and available as separately paginated history. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R29 | A unit owns its conversation, branch, pull request when one exists, rounds, preserved work, and unresolved conditions. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R30 | A run is evidence for the work that produced it; generic parent/child run lineage also remains available for compound read-only work outside a pipeline. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R31 | A plan's human provider address is linked as context, while its parent issue never becomes runtime parentage or mutable execution truth. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R32 | Agent names may appear as secondary run metadata but never determine page types, navigation, hierarchy, or status language; user-facing copy uses `code`, not `coding`. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R33 | Each person gets one private broad stream containing their own messages addressed to the organization orchestrator and the replies and receipts addressed to them; it never interleaves another person's conversation. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R34 | Messages sent to a unit or other local thread remain in that durable thread and are not duplicated into the broad personal stream. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R35 | The default dock shows the current person's broad stream on every non-focus Home, pipeline, unit, thread, PR, and Run-details view where chat is available. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R36 | The current view may be attached as explicit, removable context to resolve references such as “this unit,” but it never changes organization, authority, session, or destination. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R37 | Pipeline pages never own a composer; their asking thread is linked provenance and the broad organization-orchestrator stream remains available. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R38 | Unit and other local-thread transcripts are read-only while the broad stream is writable; **Reply in this thread** explicitly enters local focus and makes only that thread writable. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R39 | Local focus sends through the browser door to the unit's one durable thread without impersonating its origin surface; any adapter projection reports delivery success or failure separately. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R40 | Local focus is route-scoped: navigating away, switching entity, browser back/forward, or reload exits focus and restores the broad stream; a deep link never begins writable. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R41 | Draft text is preserved separately per authorized destination, but focus itself is never restored implicitly. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R42 | The active destination and any attached context remain persistently visible and programmatically announced before send. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R43 | The interface never presents two writable composers, stacked chat overlays, or an ambiguous message destination. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R44 | A thread browser may search, filter, and navigate without adding a composer and applies the discovery states in R23 to every result set. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R45 | The first accepted authorized answer clears the matching durable pending question and resumes the same unit; duplicate or later answers start nothing and receive a resolution receipt. | Required; inspect linked spec. [organization-orchestration](../reference/specs/organization-orchestration.md). |
| R46 | A pipeline page shows current attention, all unresolved units, the orchestrator's next act, plan provenance, and completed history without becoming a second chat surface. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R47 | A unit page presents the durable unit thread as the reading spine, with rounds and child runs in chronological context. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R48 | Pull requests remain contextual to units and open in the reusable main-pane diff experience rather than a separate product hierarchy. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R49 | Runs open as **Run details** from the work they evidence while retaining canonical shareable URLs and an advanced global index. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R50 | Conductor children use generic parent-run navigation and do not receive a conductor-specific Home section, page, or vocabulary. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R51 | A unit may target and publish to a different repository from other units in the same pipeline; pipeline UI does not imply one inherited repository. | Approved separate engine migration; retain truthful current behavior. [browser-home](../reference/specs/browser-home.md). |
| R52 | Primary navigation contains Home, Delivery, Costs, and Metrics. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R53 | Runs remains an advanced global index and contextual destination rather than a competing primary work surface. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R54 | Residents moves to **Settings → Runtime**, retaining its management capabilities. | Required; inspect linked spec. [resident-repos](../reference/specs/resident-repos.md). |
| R55 | Existing authorized thread, run, unit, pipeline, and pull-request addresses remain directly shareable through the transition. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R56 | `/plane` resolves to Home, and existing thread entry points converge into Home discovery rather than a second Home experience. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R57 | Planning establishes and tests a supported worst-case unresolved-unit count plus first-attention and complete-list response budgets from current fleet evidence before implementation is declared ready. | Open live fleet sizing and latency qualification; local fixture timing is narrower proof. [load-harness](../reference/specs/load-harness.md). |
| R58 | View state and preferences are keyed by actor and authorized organization so future multi-organization access does not require replacing local-state assumptions. | Required; inspect linked spec. [live-view](../reference/specs/live-view.md). |
| R59 | This release does not add Teams, organization switching, a shared transcript, or shared-authority conversation semantics. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R60 | Narrow layouts preserve the same attention order and one-composer invariant without omitting unresolved work. | Required; inspect linked spec. [load-harness](../reference/specs/load-harness.md). |
| R61 | Every interaction is keyboard-operable with visible focus, restored focus after mode changes, semantic state and destination announcements, and usable touch targets. | Required; inspect linked spec. [load-harness](../reference/specs/load-harness.md). |
| R62 | Attention, wait owner, current state, focus mode, destination, and next act remain understandable without relying on color alone. | Required; inspect linked spec. [load-harness](../reference/specs/load-harness.md). |
| R63 | **Settings → Identities** is the first-release human flow for viewing, linking, and unlinking surface identities; every change requires current authorization and fresh proof of control of every affected identity, is auditable, notifies the affected identities, refuses unresolved conflicts, and provides recovery through an organization identity administrator. | Required; inspect linked spec. [person-directory](../reference/specs/person-directory.md). |
| R64 | Every admitted message or act preserves its source actor identity and a per-act idempotency key through admission and resulting durable acts; admission scopes that key by organization, source, and actor. | Required; inspect linked spec. [organization-orchestration](../reference/specs/organization-orchestration.md). |
| R65 | A retry with the same scoped idempotency key and payload starts nothing twice and returns the original durable accepted, rejected, or pending receipt; reuse of that key with a different payload is rejected as a conflict, while a new key is treated as a distinct submission and starts a new act only if otherwise admitted, even when its actor or payload matches an earlier act. Adapter-delivery failure remains distinct from act acceptance. | Required; inspect linked spec. [organization-orchestration](../reference/specs/organization-orchestration.md). |
| R66 | **You** means a condition explicitly addressed or assigned to the current actor, or one only that actor can authorize; **us** means organization-owned work assigned to automation, another named maintainer, or an unassigned authorized maintainer pool; **the world** means an external system or actor. Only **you** enters personal urgent attention, and every **us** condition names its specific owner class. | Required; inspect linked spec. [browser-home](../reference/specs/browser-home.md). |
| R67 | Organization-orchestrator ingress is bounded by actor, source, organization, and workload class; overload from one lane cannot starve durable fleet reconciliation or other actors, and every throttled or rejected submission starts no act and receives an explicit receipt. | Required; inspect linked spec. [organization-orchestration](../reference/specs/organization-orchestration.md). |

## Nine original user flows

These preserve the original flow scope. Home inline answering extends F4; the
weekly timeline refines F7. The engine exceptions above govern F3.


- F1. **Open Home and triage attention**
  - **Trigger:** the maintainer opens the browser or follows `/plane`.
  - **Actors:** the maintainer, the orchestrator
  - **Steps:** Home presents maintainer-owned conditions first, then moving work, then other waits; the maintainer can inspect a pipeline or message the orchestrator without losing fleet context.
  - **Covers:** R18-R24, R56, R66
- F2. **Link an identity and continue one broad conversation across web and Slack**
  - **Trigger:** the maintainer opens **Settings → Identities** in an authenticated browser session and chooses to link Slack.
  - **Actors:** the maintainer, the orchestrator
  - **Steps:** the maintainer proves current control of both identities; conflicts block the link and offer identity-admin recovery; both surfaces receive notice; after success, an organization-orchestrator message sent from Slack and its ordered reply appear once in the maintainer's broad stream; a Home follow-up continues that stream without impersonating Slack.
  - **Covers:** R1-R9, R33-R36, R63
- F3. **Inspect coordinated work**
  - **Trigger:** the maintainer opens a pipeline from Home.
  - **Actors:** the maintainer, the orchestrator, a worker, an external system
  - **Steps:** The pipeline explains unresolved units and next acts; the maintainer follows a unit, plan, PR, or run without entering another conversation.
  - **Covers:** R25-R32, R46-R51
- F4. **Answer a unit question**
  - **Trigger:** the maintainer opens a unit with a durable question.
  - **Actors:** the maintainer, the orchestrator, a worker
  - **Steps:** The unit thread is readable beside the maintainer's broad stream; the maintainer explicitly enters local focus; the browser sends once to the durable unit thread; the accepted answer resumes the same unit; leaving the route restores the broad stream and its draft.
  - **Covers:** R12-R14, R34-R45
- F5. **Resolve competing answers**
  - **Trigger:** Two authorized maintainers answer the same pending question nearly simultaneously from different supported surfaces.
  - **Actors:** the maintainer, the orchestrator
  - **Steps:** One answer clears the versioned question; the unit records that actor; the later answer starts nothing and its author receives a receipt naming the already-resolved fact without exposing the first person's private stream.
  - **Covers:** R8-R9, R45
- F6. **Inspect execution evidence**
  - **Trigger:** the maintainer follows a PR or **Run details** link from a unit or pipeline.
  - **Actors:** the maintainer, the orchestrator
  - **Steps:** Evidence opens in the main pane with authorized work context available to attach and the broad stream available unless local focus is active.
  - **Covers:** R10-R17, R35-R36, R48-R50, R55
- F7. **Find prior conversation or completed work**
  - **Trigger:** the maintainer needs a thread or completed unit absent from active Home.
  - **Actors:** the maintainer
  - **Steps:** the maintainer searches authorized conversation history or opens paginated completed history without activating another composer.
  - **Covers:** R16, R23, R28, R44, R53, R55
- F8. **Retry after an uncertain delivery**
  - **Trigger:** A supported surface times out after submitting an organization-orchestrator message or unit answer.
  - **Actors:** the maintainer, the orchestrator
  - **Steps:** The surface retries with the same scoped idempotency key and payload; admission returns the original receipt; the message appears once and no durable act repeats; a changed payload under that key is rejected visibly, while a new key is treated as a distinct submission and starts a new act only if otherwise admitted.
  - **Covers:** R64-R65
- F9. **Contain an ingress flood**
  - **Trigger:** One human, service actor, or integration exceeds its admitted workload while shared fleet reconciliation and other actors remain active.
  - **Actors:** the maintainer, the orchestrator, a service actor
  - **Steps:** Excess submissions from that lane are throttled or rejected with explicit no-act receipts; durable reconciliation and other actors continue within their supported budgets.
  - **Covers:** R67


## Twenty original acceptance examples

These examples retain the original expectations. AE14's multi-repository example
is the approved separate migration, not current acceptance. AE2 retains the
original owner classification but its us/world product labels are superseded by
Moving and Other waits. AE8 requires the open R57 live qualification.


- AE1. **Covers R18-R22.** Given a run ended but its unit retains an unanswered production-validation question, when Home loads, then the unit appears under **Needs you** with the question and next act rather than as done.
- AE2. **Covers R20-R21, R66.** Given a condition is assigned to the maintainer, another is unassigned to the authorized maintainer pool, a third belongs to an automatic retry, and a fourth waits on a provider, when the assigned maintainer and another authorized maintainer open Home, then only the assigned maintainer sees the first under urgent **Needs you**; both see the shared and automatic work as **us** with the exact owner class, and the provider wait as **the world**.
- AE3. **Covers R5-R7, R33, R63.** Given one person initiates a browser-to-Slack link, when they prove fresh control of both identities, then the link is recorded and both receive notice; afterward one private broad stream preserves both source identities and original actor records. An unlinked identity remains separate, a claimed identity without proof cannot join, and an identity administrator can recover a conflicted link without rewriting history.
- AE4. **Covers R6-R9, R33.** Given two maintainers message the organization orchestrator while viewing the same unit, then both acts reach the shared fleet, each is authorized and attributed separately, and neither private stream displays the other's message text.
- AE5. **Covers R8-R9, R45.** Given two maintainers answer one versioned unit question, then the first accepted answer resumes the unit once, the second starts nothing, and both can see the resulting shared fact while only the losing actor receives the losing receipt in their private destination.
- AE6. **Covers R10-R13.** Given a valid identifier for another organization or a local thread the actor cannot read, when Home, search, a live stream, context attachment, or a direct URL requests it, then no data is returned and the response is indistinguishable from unknown; revocation closes an already-open view, places focus on a permission-safe explanation, and returns the broad stream only if organization access remains.
- AE7. **Covers R14, R41.** Given two users in one organization share a browser profile, when they sign in separately, then neither can access the other's broad draft, focused-thread draft, attached context, scroll, or focus state.
- AE8. **Covers R27-R28, R57.** Given the evidence-derived worst-case unresolved and completed unit counts, when a pipeline loads, then attention is usable within the first budget, every unresolved unit is discoverable in one logical list without page navigation, and completed history remains separately paginated.
- AE9. **Covers R34, R38-R43.** Given the maintainer has an unsent broad-stream draft and explicitly focuses a unit, when they reply and navigate away, then the message appears once in the unit thread, only that composer was writable, and the broad draft and scroll return without the unit message being copied into the broad stream.
- AE10. **Covers R39-R40.** Given a Slack-originated unit thread, when the maintainer focuses it from Home and replies, then the browser records one canonical unit-thread message, reports whether Slack delivery succeeded, and never impersonates a Slack-authored message; reload exits writable focus.
- AE11. **Covers R36.** Given the maintainer opens a unit with attached context and asks about unrelated fleet work, then the broad organization orchestrator still receives the message and the attachment neither rejects nor retargets it.
- AE12. **Covers R37, R46.** Given a pipeline began from an asking thread, when its page opens, then the thread is available as provenance but no pipeline composer or second chat appears.
- AE13. **Covers R48-R49.** Given a unit has a pull request and three child runs, when the maintainer opens each item, then the PR uses the main-pane diff and each run uses **Run details**, while the unit remains available as context.
- AE14. **Covers R51.** Given one pipeline has units targeting two repositories and publishes its plan in a third, when Home and the pipeline page render, then each unit shows its own target and publication context without inheriting the plan repository.
- AE15. **Covers R24, R54.** Given a runtime failure threatens active work, when Home loads, then the failure appears with affected work; routine inventory and controls remain under **Settings → Runtime**.
- AE16. **Covers R55-R56.** Given an authorized person follows an existing canonical thread, run, unit, pipeline, PR, or `/plane` URL, when navigation completes, then they reach the corresponding Home-context view or redirect without losing the durable address.
- AE17. **Covers R60-R62.** Given a narrow viewport, keyboard-only use, a screen reader, touch input, or color-vision deficiency, when the maintainer triages Home or changes message destination, then ordering, focus, labels, announcements, target size, and state preserve the same meaning and authority as the wide layout.
- AE18. **Covers R64-R65.** Given Slack, GitHub, HTTP, or Home retries an accepted act after a timeout, when the same organization, source, actor, idempotency key, and payload arrive again, then no conversation entry, unit resume, or mutation repeats and the original receipt returns; a different payload under that key is rejected, while a new key is treated as a distinct submission and starts a new act only if otherwise admitted, even if its payload is identical.
- AE19. **Covers R23, R28, R44.** Given thread search or completed history is loading, empty, permission-filtered, partially unavailable, or fully caught up, when the maintainer opens it, then each state is distinguishable and neither filtered nor missing data is presented as no matches.
- AE20. **Covers R67.** Given one authorized actor or integration floods the organization with distinct submissions while shared work and another actor remain active, when its bound is exceeded, then excess submissions start no act and receive throttled or rejected receipts while durable reconciliation and the other actor continue within their supported budgets.


## Review and delivery sequence

1. Finish local source preparation and named checks. Keep the frontend push and
   review requests held until the current release has merged. The frontend is
   the first change intended for the next release.
2. Rebase, slice, amend, push and submit with the native stack tools. Preserve
   every existing branch/PR owner and clean linear commits. Required CI must
   qualify the current heads; old-head checks do not count.
3. Temporarily target the tip PR at main. Give it a plain-language full-stack
   description and this complete design contract. Request ONE deep review through
   the existing configured review channel, covering the cumulative diff and design.
   The Review default is Sol; no manual model override is needed. Require the
   actual receipt to resolve `openai/gpt-6.1-sol` with high effort. This supersedes the
   older per-layer LGTM requirement for this frontend stack.
4. Address findings at their coherent original layer, then rebase the stack as
   a unit. Requalify the current tip if its head changes. Record the reviewed
   head, tree, main base and full scope. Restore the tip's preceding-stack base
   only after review and CI are green; retain the cumulative review receipt.
5. Use the existing CI staging path for the final combined candidate after the
   source/CI/review work is complete. Coordinate the single staging environment
   with the release owner. No competing deployment, manual upload, marker reset,
   replacement controller or fabricated check substitutes for natural CI.
6. Prove genuine MCP tools/call Review admission from the current authorized
   actor, the original run/thread receipt, actual model/effort and review/PR head.
   HTTP admission followed by MCP observation is a different, narrower proof.
   Prove a real authorized Slack post and response from the same candidate.
7. Drive authenticated frontend journeys on that exact staged build, including
   Home answers, private broad/focused conversation, user scopes, weekly history,
   evidence links, Metrics, identities/runtime and phone/desktop themes. Use
   disposable fixtures within their existing authorization and ownership bounds.
8. Merge the qualified stack as a unit under the user's merge approval. Keep
   merge, next release, deployment and live acceptance distinct in the receipt.

## Evidence and remaining qualifications

The source/spec map above tells the reviewer where behavior should be proved.
The original source audit was narrower than release acceptance. Local fixture
captures and timing never establish production or private-native behavior.

- Bind every test, render, CI result and review to the actual source/diff it saw.
  Named checks and type/spec/docs gates are local proof; full suites remain in CI.
- Record an authorized fleet census and sizing assumptions before closing R57.
  A 1,000-unit fixture and browser timing demonstrate only that fixture workload.
- Keep Cloudflare/private-native latency, authenticated restart/revocation,
  signed deletion/offline events, identity notices and physical screen-reader/
  touch qualification explicit until their live evidence exists.
- An unknown admitted effect keeps its original identity and receipt. Read its
  state before retrying; never recreate it under a different writer or key.
- Do not declare cutover complete until the old presentation is removed, source
  parity is established and the exact staged candidate passes the required user
  journeys and MCP/Slack acceptance. No gap is closed by relabeling it.
