---
title: A person outlives the surfaces they use
status: proposed
date: 2026-09-25
pattern: Verified external identities resolve to a durable person; each request retains its actor, authority and surface
---

# A person outlives the surfaces they use

**The ask.** Make cross-surface continuity a core capability, proved early, so a person can find and continue work through the browser, Slack, MCP and CLI. Issue #2376 asks for this docs-only decision, using the reviewed draft in issue #2370, comment `5840097426`; issue #2369 owns the wider delivery. This is a proposed successor to the email auto-link rule in [record 0042](0042-a-dashboard-session-is-the-person-its-email-names-identity-not-authority.md), not a claim that its current rule has already changed. It preserves the one authorization table and the `ChannelIO` seam.

## TL;DR

A person is not their email, Slack id, browser session or API credential. Verified external identities bind to one opaque, durable person; the binding is a revocable authorization input for self access, not a transfer of grants. A portable conversation additionally needs its own durable identity, explicit read/write rules and immutable per-turn attribution. Resolving two callers to the same person is necessary for continuity, but it neither merges their histories nor makes every channel a place they can speak.

The first vertical proof is a browser-started thread continued through independently authenticated MCP and person-scoped CLI after restart, using the same server-issued thread id and ordered history. An unbound caller is denied; unlink removes the formerly linked caller's binding-derived access, including pending confirmations. The calling actor's current grants govern throughout. That flow must eventually work without Slack credentials or connectivity; this proposal does not switch any runtime behavior on.

## Pressure test against the implementation

These are source observations at `7e76aedb8ad5b5ed4a0a93daa300937a9b7272e8`, not claims about a deployed cutover.

| Fact today | Source | Consequence |
| --- | --- | --- |
| `Actor.id` identifies the authenticated surface actor; a bound message names the requester in `userId` and the credential in `authenticatedAs`. `resolveChatActor` retains the credential's grants and adds the requester to `self` and `asUser`. | `src/core/authz/actor.ts`: `resolveActor`, `resolveChatActor`; `src/core/types.ts`: `IncomingMessage` | Person, source requester and current credential must remain distinguishable. Replacing the actor with a shared person would change grant lookup and erase attribution. |
| Browser linking and configured ingress/CLI binding resolve an email through Slack, yielding a `slack:` id. The reverse lookup caches answers per process. | `src/channels/commandHttp.ts`: `resolveAccessActor`; `src/channels/requester.ts`: `boundRequester`; `src/channels/slack/lookups.ts`: `resolvePersonByEmail`; `src/cli.ts`: `cliRequester` | Today's link is neither a durable person directory nor proof of independent control of both accounts. A Slack outage can remove the bridge. |
| `is-self` compares resource `userId` with the actor's self set. `actsAsPerson` literally tests for the `slack:` prefix. The store predicate compiles the same self set to ORed `user-is` checks. | `src/core/authz/authorize.ts`: `selfIdsOf`, `actsAsPerson`, `evaluateCondition`; `src/core/authz/predicate.ts`: `selfPredicate`, `compileCondition`; `src/core/authz/policy.ts` | Linking affects private reads, personal configuration/memory policy and self-service commands even without adding a grant. Point checks and list predicates must migrate together. |
| A pending confirmation's requester may match any supplied clicker actor id; a command confirmation then reauthorizes the stored requester's message, not a newly attributed cross-surface turn. | `src/core/confirmations.ts`: `judge`, `ConfirmationStore.consume`; `src/core/confirmations.test.ts`; `src/core/dispatch/confirm.ts`: `actorIdsOf`, `consumeAndRun` | Unlink must affect confirmation acceptance as well as run reads. Portability must also fence the accepting actor's authority, not inherit the offerer's credential. |
| Web thread keys include the Access subject. `ownLane` refuses sends outside that subject's lane even when the viewer may read its runs. | `src/channels/web.ts`: `threadKeyFor`, `ownLane`, `requesterOf`, `send` | A shared person alone cannot make the next turn portable. Read access and send access already differ. |
| Session keys derive from the thread key; the thread session has its own `@thread` lane, row identities and migration rules. | `src/core/runLedger/sessionLog.ts`: `sessionKey`, `threadSessionKey`, `connectorRowId`, `storedTurnRow`, `migrationOrder` | Extend the existing log and handle/access model. Do not create a second transcript store or infer continuity from whichever recent runs a UI loaded. |
| Records and ownership predicates use platform-shaped `userId`; personal MCP credential keys include their scope, authenticated as AES-GCM additional data. | `src/core/runRecord.ts`: `RunRecord`, `matchesVisibility`; `src/mcp/registry.ts`: `mcpCredentialKey`; `src/mcp/sealed.ts`: `sealCredential`, `openCredential` | A global id rename would change access and break sealed credentials. Historical attribution and personal-scope migration need separate treatment. |
| The shared `cli:local` actor has `ALL_GRANTS`. `runBot` requires both Slack tokens before starting the other surfaces. | `src/core/authz/actor.ts`: `CLI_ACTOR`; `src/index.ts`: `runBot` | Local operator authority is not evidence of human identity; Slack-independent operation requires a later startup change as well as identity work. |

Account linking **does affect authorization** today. The phrase “identity, not authority” in record 0042 accurately excludes grant union, but does not describe the entire security effect: changing `self` changes which private resources and personal operations policy admits. A binding is a policy-relevant relationship. Channel membership and repository rights remain separate inputs, not consequences of sharing a person id.

Shared personhood also does not itself make a conversation portable. A thread, its run history and its notification target are distinct objects with distinct permissions. [Record 0070](0070-the-control-plane-is-where-the-maintainer-works-the-plane-page-pins-a-chat-column-beside-the-panels-and-an-orchestrator-thread-answers-about-the-fleet-and-acts-on-it.md) calls for one durable orchestrator thread per person; this decision supplies identity and access inputs for that promise, not a replacement navigation or orchestration design.

## Terms

| Term | Meaning here |
| --- | --- |
| **External identity** | A subject authenticated by an issuer and tenant or workspace, such as Access issuer + subject or Slack workspace + user id. A credential proves it; the credential is not the person. |
| **Person** | An opaque, durable Switchboard id for one human, independent of email, display name and surface ids. |
| **Binding** | A verified, versioned, revocable relationship from an external identity to a person. It is an authorization input for self access. |
| **Actor** | The authenticated caller and request context, including surface, grants and delegation. A service can be an actor without being a person. |
| **Thread** | Durable conversation identity and history. Its owner, readers, writers and per-turn actors are explicit; a channel address is a delivery route. |

OIDC and NIST use issuer-plus-subject identifiers rather than email as identity keys. Auth0's account-link guidance asks for authentication of both accounts. OpenFGA's user–relation–object model is useful vocabulary for separating a person binding from thread reader, writer, ownership and channel membership; Switchboard can express those relations through its current policy and store seams. MCP authorization likewise requires each call to authenticate its own client and subject; possession of a task handle is not task access.

For continuity, Temporal distinguishes a stable Workflow ID from one execution's Run ID, while LangGraph uses a thread id to recover checkpoints across invocations. The useful pattern is a stable, server-issued thread handle distinct from each run and each delivery address. Slack's `channel` + `thread_ts` is a surface address, not the durable cross-surface identity. These are design analogies, not dependencies on those workflow engines or a proposal to turn guessed ids into capabilities.

## Proposed decision

### Verified identities resolve through one directory

Add a directory seam with in-memory and durable implementations. A binding key includes issuer and immutable subject, plus tenant or workspace where needed; the same subject string under another issuer or tenant is a different identity. Enforce one active person per external identity atomically, while allowing several independently authenticated human identities to bind to one person. A race between conflicting bindings cannot commit both, and a stale update cannot undo revocation.

Persist the binding's proof method, proof version, state and revision, plus attributable link, unlink and recovery receipts. Do not persist tokens or raw email in run events or binding proof payloads. Email can suggest a link but cannot establish one. Unknown, conflicting, revoked and unavailable resolutions remain distinguishable outcomes; none supplies a cross-surface person claim. An authenticated actor can still exercise rights independently granted to that actor. Directory failure is never permission to guess a person or fall back to email auto-linking.

Adapters authenticate the issuer, subject, audience and relevant tenant context before asking the directory. A person id from message text, MCP arguments or a caller-controlled token field is not a binding. Authentication identifies the external subject; directory resolution supplies verified relationships; the existing policy table alone decides access.

### A link is a scoped security decision, never a grant union

A link ceremony proves control of both human identities or uses a separately audited administrator recovery path. A link is not an arbitrary person merge: recovery must not combine unrelated private histories because names or emails look alike. The exact Slack/Access ceremony and exceptional recovery procedure are acceptance gates below, not silently chosen by a directory implementation.

Unlink invalidates future binding-derived self reads, writes and confirmation acceptance. Decisions use current binding state, not a run's historical `personId` or a cached positive answer whose validity cannot be established. The implementation must define the revocation fence for concurrent admission, confirmation consumption and continuing streams; a new request after committed revocation must not be admitted by stale state. Previously delivered bytes and historical attribution are not rewritten. Independent grants, such as an explicit administrator read, are not revoked by unlink and must not be confused with binding-derived self access in tests.

The authenticated actor's current grants still determine each action, without union of another surface's grants. Channel membership and repository rights need their own current facts. A pending confirmation retains its exact proposed action and existing expiry/single-consumption fences; another surface may accept it only if its current binding, thread permission and action authorization all permit it. Linking must not let a read-only actor execute an action offered to a more privileged actor.

A service credential may act for a person only through explicit delegation with audience, scope and revocation. It is not another authenticated human merely because its configuration contains an email. Delegation remains visible in attribution and is bounded by its own policy, never borrowed from a human account's grants.

### Attribution and ownership are separate fields

Add `personId` beside existing `userId`, `authenticatedAs`, actor and channel ids in admitted messages, run and thread records, and audit receipts. Keep a reference to the binding revision/proof used at admission without carrying its secret material. Do not silently repurpose `userId`: existing records, indexes, predicates, personal scopes and sealed MCP credential keys use its platform-namespaced value. In bound messages that value may already name a Slack requester rather than the authenticating credential; preserve what was recorded, with `authenticatedAs` beside it, instead of claiming it was an opaque person id all along.

A versioned migration may dual-query new ownership fields and verified legacy aliases, but the point decision and compiled store predicate must admit exactly the same resources. Unverified or ambiguous legacy ownership stays unclaimed for cross-surface access. A current binding does not retroactively rewrite an old record's author or transfer a previous person's resources on account reassignment; alias provenance and the ownership migration must establish which historical records actually belong to the person. Do not bulk backfill ownership from matching emails or a shared service/CLI id.

Choose one authoritative personal config and memory scope before enabling migrated writes. Any legacy reads, conflict resolution, copy or retirement must be versioned and retry-safe; two scopes cannot remain independent writable sources of truth. A sealed MCP credential cannot be moved by renaming its scope key or copying ciphertext. Preserve the old seal context behind an explicitly authorized migration mapping or require a fresh connection under the new scope; the migration owner must select and prove the path. Promotion to org scope remains record 0042's re-issue rule, never transfer of a person's token to everybody.

Historical attribution stays fixed; current binding and current policy control access. Removing a binding neither deletes the person's thread nor changes the identity that authored a past turn.

### Thread access is independent of identity and delivery

A person can discover owned threads through any bound human surface if that actor passes a thread-read decision. Continuing requires a separate thread-write decision and a server-issued thread id independent of surface addresses. These are proposed capabilities in the one policy table, not claims that actions named `thread:read` and `thread:write` exist today. A handle is returned only after durable thread creation; knowing it confers no access.

The thread retains its durable owner, distinct from the agent that owns its execution, plus explicit reader/writer relations. Every accepted turn records the actual actor, resolved person when present, delegation, originating surface and request identity. The owner is not replaced by the latest speaker. Stable handles resolve to the existing session log, so restart and another surface reconstruct the same context rather than copying a conversation into a new lane. The append contract must define ordering, idempotent retries and concurrent-write conflicts while preserving one live run per thread; binding two identities must not admit two live runs.

A read of a historical run does not imply permission to append to the thread, speak in its Slack channel, or subscribe another destination to its private events. `ChannelIO` renders authorized events and sends only to an eligible route. MCP and CLI expose their own authenticated poll or stream contracts over the same events; delivery status is not conversation ownership. Reading, continuing and delivering each require the relevant current policy decision. Reuse the existing session log and channel seam rather than creating another transcript or notification system.

Record 0070's personal orchestrator thread is the first concrete case: the same person's verified surfaces may reach one conversation, but each turn uses its caller's own authority. This does not create a shared organization conversation or settle channel-owned thread membership. Those access models must be decided explicitly before such threads become portable.

### Local operators and machines do not become people

`cli:local` with `ALL_GRANTS` is an installation actor, not a personal identity or proof that a configured email owns a person's history. Person-scoped CLI continuity needs user authentication and its own actor policy, distinct from local-operator mode. MCP OAuth tokens require issuer, audience and subject validation before binding resolution; opaque service tokens need explicit delegation. This is a target contract, not a claim that the current static ingress token map is an OAuth identity provider.

Browser, authenticated MCP and person-scoped CLI must ultimately operate without Slack credentials or connectivity. A Slack directory lookup may enrich Slack-specific facts, but cannot be a prerequisite for non-Slack person resolution, thread access or process startup. Startup/config changes come after a working non-Slack route; this record does not remove the current Slack requirement.

## Proof sequence and release gates

These are required future implementation proofs, **not tests added or passed by this docs-only PR**. Each implementation unit adds living spec rows and exact test bindings with its behavior. No record acceptance or directory-only merge proves the end-to-end capability.

| Stage | Required evidence before enabling its behavior |
| --- | --- |
| Directory | Both store implementations prove two authenticated subjects binding to one person, atomic subject uniqueness under concurrency, issuer/tenant isolation, conflicting and stale revisions, restart, revocation and stale-cache refusal. Missing/unavailable directory and email collision produce no person claim. Receipts preserve proof method/version without tokens or raw email. |
| Verified linking | Both-account proof, replay-resistant linking, unauthorized linking, unlink and administrator recovery are covered. Recovery cannot combine unrelated private histories. Service credentials require separately scoped, revocable delegation. An explicit legacy email-bridge migration rule exists before ingress changes. |
| Authorization and migration | Point checks equal compiled list predicates for browser, Slack, MCP and CLI across bound, unbound, revoked and legacy records. Cover private runs, personal config/memory writes, pending confirmations, channel membership and service delegation. Include same-person actors with unequal grants, ambiguous legacy aliases and credential-scope migration failure. No grant union, ownership rewrite or broadened fallback. |
| Stable thread | A web-started thread continues through authenticated MCP and person-scoped CLI using the same handle after process restart, with one ordered history, correct per-turn actor/origin and unchanged owner. Concurrent appends/retries obey the chosen order and duplicate policy without starting a second live run. A readable-but-not-writable actor cannot append. |
| Revocation and delivery | An unbound caller cannot read or continue the private thread. After unlink, the formerly linked caller cannot use the removed relationship to read, continue or accept a pending confirmation, including across restart and stale caches. Test a confirmation both before and after unlink, and deny delivery to an unauthorized route even when the requester can read the thread. |
| Slack-independent acceptance | Repeat browser, MCP and person-scoped CLI list/read/continue/status, restart and unlink/denial flows with Slack credentials absent and Slack connectivity unavailable. Capture live receipts in addition to tests. Non-Slack authentication, ordering and authorization must not depend on a successful Slack lookup. |

## Reconciliation and rollout

**Record 0042 remains accepted and unchanged here.** Its present email bridge is not silently replaced by merging a proposal. This decision would supersede the email-as-proof premise only at the verified-binding cutover, documented by an amendment or successor linkage that names precisely what changed. It preserves the separate authenticated actor, no grant union, policy-table decisions, source-id attribution and promotion by re-issue. It corrects the broader security claim that linking cannot affect authority: self and membership are authorization inputs even when grants are identical.

**Record 0070 keeps its conversation promise and its fences.** Person-scoped continuity supplies a stable identity and thread access contract; it does not accept a new shared-org chat, change `/plane` navigation, create a merge grant or alter the orchestrator/unit lifecycle. A thread does not carry a standing credential that its next speaker inherits. The code survey in record 0070 is historical, not an assertion about today's checkout.

**The existing session log remains canonical.** Coordinate stable handles with issue #1058, surface projections with #2061 and waiting/confirmation UI with #2224. Source-conversation access recovery (#2333) and multipart delivery formatting (#2311) remain separate work. [Record 0077](0077-a-plan-becomes-a-durable-work-record-before-code-starts.md) owns durable plan identity and provider projection; this record adds no plan store or repository plan ledger.

Delivery follows issue #2369: this docs-only prerequisite; directory contract with no ingress change (#2370); verified linking; authorization/record and legacy-scope migration; stable thread access; surface projections; then Slack-optional startup and cross-surface live acceptance. Every stage remains behind its own proofs and current source-ownership checks. This record is not approval to begin a competing writer on a shared source path.

If a migration gate fails, keep the new cross-surface access disabled. Rollback may stop new links or continuation but must preserve durable ownership, attribution and revocation state; it must not resurrect a revoked link through the old email bridge. Existing independent actor rights remain governed by their existing policy. Do not activate new private access until the rollback/cutover version rules can preserve that boundary.

## Decisions still required before implementation reaches the boundary

| Decision | Owner and gate |
| --- | --- |
| Exact Slack/Access link ceremonies, replay protection, revocation concurrency fence and administrator recovery evidence | Verified-link implementation owner and maintainer, before any binding can widen access. |
| Whether an explicit temporary legacy email bridge remains, its allowed population and retirement condition | Migration owner and maintainer, before ingress cutover; email never creates a verified binding and cannot override revocation. No indefinite parallel link rules. |
| Historical alias assignment, one authoritative personal config/memory scope, conflicts and safe MCP seal-context migration | Authorization/migration owner, before migrated private reads or personal writes. |
| Person-owned versus channel-owned thread relations, append ordering/conflicts and which confirmations are portable | Thread-access owner, before cross-surface continuation; the personal orchestrator is the first case, not implied permission for every thread. |
| Person-level grants, if ever desirable | Separate future decision. Initially only actor grants plus verified relationships; automatic grant transfer is excluded. |

The directory-only unit can implement and prove its seam without deciding ceremonies or switching ingress. No unit may interpret an unresolved entry as permission to invent a fallback.

## Consequences and alternatives

**The cost.** A durable directory, account-proof UX, revocation-aware reads and streams, policy/predicate migration and personal-scope reconciliation add work before continuity becomes visible. Link/recovery operations become security-sensitive and auditable. A directory outage can remove binding-derived access even when credentials still authenticate; that loss of convenience is preferable to guessing at private ownership.

**Why not keep email auto-linking?** Email is mutable and reusable across accounts and tenants. The current bridge is useful history, but cannot prove both identities or support durable revocation. Treating it as a suggestion retains convenience without making it an ownership key.

**Why not replace every `userId` with the person id?** Existing ownership predicates, indexes and sealed credential keys already assign meaning to that field. Renaming loses provenance, can widen private access and can make credentials unreadable. Add explicit fields and migrate under proofs instead.

**Why not union grants for all of a person's accounts?** A weak credential would inherit a stronger surface's powers. The caller's authority must remain attributable and revocable independently of person continuity.

**Why not let run-read access imply thread-write or channel-send access?** A historical read, a new turn and a notification expose or change different resources. Conflating them would let a linked reader speak into a channel they cannot join or redirect private events to a foreign destination.

**Why not copy the conversation into each surface?** Copies fork ordering, pending confirmations, ownership and run admission, and recreate the transcript store. One handle with authorized projections makes restart and cross-surface reads refer to the same record.

## Acceptance and what would change this decision

This record stays `status: proposed`. Maintainer acceptance of the architectural direction is separate from merging these docs, deciding the gated migration choices and shipping the verified-binding cutover. Accepted records 0042 and 0070 are not edited or marked superseded by this proposal.

If the durable store cannot guarantee atomic uniqueness and timely revocation, a binding cannot become an authorization input. If point checks and list predicates disagree during migration, cross-surface private reads remain disabled. A surface unable to authenticate a human can operate as a scoped service or local operator, but cannot claim person continuity from a configured email. If stable thread handles cannot preserve ordering and ownership over the existing log, surface portability waits rather than inventing another history.

## References

- Issues #2376 (docs prerequisite), #2370 and its reviewed draft comment `5840097426` (directory contract and source text), #2369 (cross-surface delivery), and #465 (original identity problem).
- Accepted records [0042](0042-a-dashboard-session-is-the-person-its-email-names-identity-not-authority.md) and [0070](0070-the-control-plane-is-where-the-maintainer-works-the-plane-page-pins-a-chat-column-beside-the-panels-and-an-orchestrator-thread-answers-about-the-fleet-and-acts-on-it.md), reconciled above; [authorization](../reference/specs/authorization.md), [web chat](../reference/specs/web-chat.md), [session log](../reference/specs/session-log.md) and [MCP ingress](../reference/specs/mcp-ingress.md) are current behavioral specs, not claims that this proposal is implemented.
- [OpenID Connect Core: subject and email claims](https://openid.net/specs/openid-connect-core-1_0.html).
- [NIST SP 800-63C: federated identifiers](https://pages.nist.gov/800-63-4/sp800-63c.html).
- [Auth0: link user accounts](https://auth0.com/docs/manage-users/user-accounts/user-account-linking/link-user-accounts).
- [OpenFGA: authorization concepts](https://openfga.dev/docs/concepts).
- [MCP Apps: authorization and token audience](https://apps.extensions.modelcontextprotocol.io/api/documents/authorization.html) and [MCP Tasks extension: task access checks](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks), design references rather than dependencies or shipped ingress claims.
- [Temporal: Workflow ID and Run ID](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/workflow/workflow-execution/workflowid-runid.mdx).
- [LangGraph: persistent thread id and checkpoint](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph).
- [Slack: thread address](https://docs.slack.dev/reference/methods/conversations.replies/).
