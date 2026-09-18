# Linear channel

The native Linear channel's installation, intake and dispatcher adapter.
Its OAuth app is the API identity; the dispatch actor is the authenticated person initiating
the session. Native delegation names the app in `Issue.delegate` and preserves
the human assignee.

- **Code**: `src/core/dispatch/runStart.ts`, `src/core/dispatch/provision.ts`, `src/core/dispatch/commandRun.ts`, `src/core/dispatch/ship.ts`, `src/artifacts/keys.ts`, `src/core/dispatch/staging.ts`, `src/core/runRecord.ts`, `src/core/runStore.ts`, `src/core/runStoreWorker.ts`, `src/core/runsService.ts`, `deploy/cloudflare-memory/worker.ts`, `src/core/coordinator/clarification.ts`, `src/core/dispatcher.ts`, `src/core/coordinator/driver.ts`, `src/core/ship/coordinator.ts`, `src/core/dispatch/lineage.ts`, `src/channels/linear/children.ts`, `src/channels/adminCoordinator.ts`, `src/core/types.ts`, `src/core/dispatch/spawn.ts`, `src/channels/startup.ts`, `src/core/dispatch/reply.ts`, `src/channels/linear/files.ts`, `src/channels/attachmentTypes.ts`, `src/channels/linear/oauth.ts`, `src/channels/linear/store.ts`, `src/channels/linear/webhook.ts`, `src/channels/linear/inbox.ts`, `src/channels/linear/api.ts`, `src/channels/linear/session.ts`, `src/channels/linear/io.ts`, `src/channels/linear/bridge.ts`, `src/channels/linear/consumer.ts`, `src/channels/linear/acknowledgement.ts`, `src/channels/linear/control.ts`, `src/channels/linear/recovery.ts`, `src/channels/linear/lifecycle.ts`, `src/channels/linear/workItems.ts`, `src/channels/linear/access.ts`, `src/core/dispatch/channelAccess.ts`, `src/core/question.ts`, `src/tools/question.ts`, `src/core/workItems.ts`, `src/tools/workItems.ts`, `src/tools/toolsets.ts`, `src/tools/runnableTool.ts`, `src/core/dispatch/runLoop.ts`, `src/core/authz/policy.ts`, `src/index.ts`, `src/core/authz/actor.ts`, `src/core/authz/grants.ts`, `src/core/budgets.ts`, `deploy/cloudflare/linear.ts`, `deploy/cloudflare/worker.ts`, `deploy/cloudflare/wrangler.template.jsonc`.
- **Tests**: `src/core/dispatch/commandRun.test.ts`, `src/core/dispatch/ship.test.ts`, `src/artifacts/keys.test.ts`, `src/core/dispatch/staging.test.ts`, `src/channels/linear/api.staging.test.ts`, `src/core/runStore.test.ts`, `src/core/runStoreWorker.test.ts`, `src/core/runsService.test.ts`, `deploy/cloudflare-memory/runs.test.ts`, `src/core/coordinator/clarification.test.ts`, `src/core/dispatcher.test.ts`, `src/core/coordinator/driver.test.ts`, `src/core/ship/coordinator.test.ts`, `src/core/dispatch/lineage.test.ts`, `src/channels/linear/children.test.ts`, `src/channels/linear/api.children.test.ts`, `src/channels/adminCoordinator.test.ts`, `src/channels/startup.test.ts`, `src/core/dispatch/reply.test.ts`, `src/channels/linear/files.test.ts`, `src/channels/linear/oauth.test.ts`, `src/channels/linear/store.test.ts`, `src/channels/linear/webhook.test.ts`, `src/channels/linear/inbox.test.ts`, `src/channels/linear/api.test.ts`, `src/channels/linear/session.test.ts`, `src/channels/linear/io.test.ts`, `src/channels/linear/bridge.test.ts`, `src/channels/linear/consumer.test.ts`, `src/channels/linear/acknowledgement.test.ts`, `src/channels/linear/control.test.ts`, `src/channels/linear/recovery.test.ts`, `src/channels/linear/lifecycle.test.ts`, `src/channels/linear/workItems.test.ts`, `src/tools/workItems.test.ts`, `src/tools/question.test.ts`, `src/core/dispatch/runLoop.test.ts`, `src/core/authz/actor.test.ts`.
- **Docs**: [Delivery plan](../../plans/2026-09-17-001-linear-channel.md).

## Behavior

1. OAuth uses `actor=app` with read, write, assignable and mentionable scopes.
   Its callback is derived only from the operator's configured origin, never
   a request's Host or return URL. HTTPS is required except localhost and
   loopback development origins. Authorization uses PKCE and expiring,
   browser-bound, single-use state. Invalid state makes no token request.
2. Installation persists the organization, app user id, access token, refresh
   token and expiry before reporting success. Browser responses disclose no
   credentials. OAuth failures return stable errors without upstream bodies.
3. Token refresh replaces both tokens atomically against the installation
   version it read. Concurrent reads on one provider share a refresh. A
   revoked or reinstalled app is not resurrected by an in-flight refresh.
4. In-memory and durable storage implementations agree on state consumption
   and installation compare-and-swap. Durable operations serialize through a
   transaction supplied by the storage implementation.
5. Webhook intake verifies HMAC-SHA256 over the exact received bytes, caps
   streamed bodies at 1 MiB, and rejects signed timestamps outside a minute
   of the adapter's clock. The configured OAuth client and optional workspace
   must match the signed payload. Session creation and prompts deduplicate by
   signed session/activity ids, never the unsigned delivery header or the
   subscription's webhook id. Persistence precedes acknowledgement; a storage
   failure is retryable and never exposes the payload in the response. Both
   acceptance and duplicate acknowledgement use Linear's required HTTP 200.
6. The event inbox is SQLite-backed in the Worker and in-memory in tests.
   Atomic claims return the oldest available event and a consumer lease.
   Expired claims are redelivered with their run binding intact. A stale
   consumer cannot renew, requeue, rebind or finish a newer consumer's claim.
   Completion drops the event payload but keeps a deduplication tombstone;
   pruning removes only completed tombstones, never pending work.
7. The bot Worker routes OAuth and Linear webhooks to a separate Durable
   Object without starting its container. Missing Linear credentials return
   503. Tokens have no HTTP read route and are not forwarded to the container.
   OAuth state expires after ten minutes and pending installations are bounded;
   an alarm prunes expired state and completed-delivery tombstones.
8. Session context resolves the authenticated human from the signed creation
   or prompt event, never from issue text or the assignee. Organization and app
   ownership must agree with the installation and the freshly fetched session.
   Follow-ups keep the same namespaced thread and carry their own message id;
   a stop signal is a control input, never an agent prompt.
9. Native session history uses immutable agent activities in chronological
   order, excludes progress noise and the triggering turn, and never includes
   a prompt that arrived after that turn. Progress is coalesced, replies use
   response/error activities, and run links are added without replacing PR links.
   A steered follow-up is acknowledged with a thought, so receipt does not
   falsely mark the ongoing session complete.
10. Linear human actors use `linear:<workspace>:<user>`. They inherit the same
    open-chat baseline as Slack, plus explicit `linear:*` and personal grants.
    A matching display name or bare user id on another platform or workspace
    never lends the actor that identity's privileges. Team visibility remains
    unknown until proven; it is never treated as public by inference.
11. The internal edge bridge authenticates before parsing a body or claiming
    work. It exposes a fixed delivery/session vocabulary, never arbitrary
    GraphQL or token reads. Each session operation rechecks current access and
    app ownership. Bridge failures return stable errors without upstream text.
12. A Linear-only bot starts without Slack credentials or a Slack socket. Partial
    Slack configuration still fails by the missing credential name. Combined
    installations start both channels. The consumer durably records entry into dispatch before invoking it. It
    renews each delivery lease while work runs, consumes unrelated sessions
    concurrently, and stops intake during drain. A replay reconciles the
    recorded run or reports an interrupted request; it never blindly repeats
    a command whose effects may already have happened. Pre-dispatch transport
    failures retain their event for retry.
    Turns in one session wait for the prior turn's admission, not its full
    execution. Stop resolves the human actor and uses the shared `runs:stop`
    policy: people can cancel their own work, while another person's work
    needs the operator's write grant and visibility. It never stops a later
    run created after the control event arrived.
    Before looking up active runs, Stop cancels authorized requests still waiting
    for dispatch admission, including a claimed request hydrating its files.
    The durable queue invalidates their leases before acknowledging cancellation;
    a late file response cannot pass `begin`. Only earlier requests in the same
    session are affected. Self-stop covers the signed requester; stopping other
    queued people requires the shared run-stop policy for that channel.
    A Stop that races an unbound dispatch records its cancellation decision on
    the delivery. If dispatch then returns a no-effects deferral, the queue
    completes the cancelled delivery instead of making it runnable again.
    Run registration awaits durable channel admission before file copies, workspace
    attach, commands or coordinator creation. A stopped unbound delivery refuses
    its run binding; an unconfirmed binding stops the local run. Once that
    dispatch settles, completion uses the original lease, so a stopped delivery
    does not replay as uncertain and cannot complete a replacement owner's claim.
    The decision survives restart and cannot be cleared by lease renewal or
    a retry; stale consumers still cannot defer another consumer's lease.
    Only the original requester may steer an active run. Another person's
    prompt stays in the durable queue until it can run under their own identity;
    unknown ownership fails closed across host generations. A proven admission
    deferral may clear the begun marker only while its lease owns an unbound
    delivery. Later prompts retain arrival order; stop controls bypass waiting.
    A permanently invalid signed request closes with an honest native error.
13. Signed revocation removes the matching installation before intake returns;
    a delayed revocation cannot remove a newer installation. It cancels pending
    session deliveries without discarding the control event that stops live work.
    Lifecycle events
    stop affected live work without invoking an agent: revocation is workspace
    scoped, removed teams are team scoped, and removal from an issue checks
    its current delegate. A permission contraction rechecks current session
    access. Notification echoes never create a second dispatch.
14. Created sessions enter an acknowledgement phase in the durable inbox.
    The edge sends a native thought without waiting for container startup,
    then releases the event for dispatch. The webhook itself waits only for
    persistence and alarm scheduling. Failed acknowledgements retry from an
    alarm with a stable activity id; a lost mutation response is reconciled
    against that activity's app, session and content. Dispatch cannot overtake
    its acknowledgement or an earlier, not-yet-admitted turn in the session.
15. Outbound files use private Linear uploads scoped to a freshly checked
    session. Only a single-file signed URL and its required headers cross to
    the executor; the installation token stays at the edge. Upload completion
    posts a native activity with an inline image or file link. A failed upload
    never posts a success link or closes the active run.
16. Issue tools bind the resolved requesting person, never a model-selected
    actor. Each operation resolves their current workspace membership and
    public-team access, then asks the shared policy table. A guest cannot
    borrow the app's public-team access; an operator grant cannot bypass
    Linear's private-team boundary. Reads and writes use separate actions.
    Restricted child teams inherit their enclosing private team's membership;
    a private child still needs its own membership.
    The paginated queue filters `delegate`, not human `assignee`. Updates name
    only requested fields; subissues inherit their parent's team without
    silently assigning a person or starting a second delegated run.

17. Before queued prompts, commands or restored runs read history or start model
    work, fresh active-human and issue-team facts cap the requester's access.
    A definite denial closes a restored row as interrupted; transient lookup
    failures leave queued and reclaimed work available for retry. Sessions
    without issue-team access facts are refused until their surface is supported.
18. An unread follow-up handed on after its run fails receives an explicit
    not-started/resend notice if its access lookup fails; it is never silently lost.
19. `request_input` records a bounded question for the end of the turn, surviving
    a restart in the run ledger. Delivery uses the channel's question method and
    a waiting indicator with unfinished checklist items; Linear emits elicitation.
    Questions from final verdict, description, and re-review turns have the same
    behavior: no further model turn is requested while an answer is needed.
    Automatic PR/review publication and memory reflection are skipped, while the
    model process is still shut down. The turn record marks that it awaits input.
    An operator stop or failure takes precedence; a new in-turn prompt clears the
    earlier question. The next native reply sees the question in its history,
    including when delegation created no opening user activity.
    A coordinator answer keeps its coding or review preset, unit branch or PR,
    round key and base. It must match the stored requester, credential, relaying
    app and unit thread; ended units and exhausted time budgets refuse the reply.
    Fresh agent and repository permission checks precede contract reconstruction.
    The coordinator follows the continuation run and uses its result in later
    briefs. Settled round cost includes earlier question turns; an unpriced turn
    or incomplete listing makes that total unknown. An unavailable coordinator
    context defers the answer before admission; an unavailable continuation
    history retries the coordinator read rather than settling from partial facts.

20. A Stop with no authorized active run does not post a completion or progress
    activity that could change another person's session. It can close the newest
    waiting question only through the shared stop policy and only if the question
    predates the Stop. An older question cannot hide a newer invisible run. A
    missing history snapshot retries rather than guessing whether a question waits.
    Closing a waiting question persists a stop marker before delivering the native
    response. A retry keeps the original marker, including after a restart or a
    late history write. Coordinator reads observe the stop without reviving earlier
    PR or review artifacts; a stale Stop cannot cancel a question finished later.

21. Private file references in issue and session text can supply inline images, PDFs
    and text documents. The edge rechecks the human and session, accepts only links
    found in current authorized context, authenticates only to uploads.linear.app
    without redirects, and bounds count and streamed bytes. Credential-shaped
    files are never read. Permanent omissions are named in the prompt; transient
    download failures before dispatch leave the delivery retryable. History restores
    attachments with a shared budget that favors recent turns. When a mention has
    no initial user activity, history restores its initiating comment alongside the
    issue, including the comment's files. The bridge allows
    four minutes for the batch; each individual upstream request keeps its ten-second
    deadline, and the consumer renews the delivery lease while it waits.

Local development may give the bot a `LINEAR_BRIDGE_URL` distinct from its
`PUBLIC_BASE_URL`, which continues to name the run pages. The bridge defaults
to the public origin in combined deployments, fails fast on invalid origins,
and permits HTTPS or HTTP loopback only. Session run-page links follow the same
transport restriction and never carry URL credentials.

Child work opens its own root comment and native session on the parent's issue.
The adapter rechecks the human requester, while the shared dispatcher remains
responsible for child-agent authorization and execution. A durable creation intent
binds the comment UUID to the installation, parent, requester and lead. Only one
session-creation mutation may be attempted per intent; an uncertain response is
reconciled from the comment's session instead of creating another session. The
app-created session's creation webhook is consumed without redispatching the child;
human prompts and Stop continue through normal intake. Rebuilt channel handles
retain this behavior after a restart. A child's reply notification cannot steer
a parent belonging to another requester or whose requester is unknown.

Coordinator record reads retain the `awaitingInput` marker and withhold earlier
PR or review artifacts while the completed turn is a question. Coding and review
rounds enter a persisted input-wait phase, re-read after durable 30-second sleeps,
and do not spawn, check PRs or merge from that question. Time awaiting a person
is reported as waiting and counts toward the unit's wall-clock budget. The last
sleep is shortened to the remaining budget; an unanswered question at or past
the deadline ends at the wall-clock cap (or review pending for an existing PR),
including after a restart. Stops and failures take precedence over a question marker.
Human-reply continuation into the coordinator's original unit is wired; live
end-to-end verification remains open.

When the bot configures an artifact store and the edge binds its bucket, incoming
files above the inline limit and binary formats are retained as references, up
to 10 per prompt and 1 GiB per file, within `artifacts.inbound.maxBytesPerMessage`
(default 2 GiB). A known positive Content-Length is required. Credential filenames
remain excluded. The channel's `copyAttachment` capability rechecks current human
access and session context at copy time, binds the destination to that session's
inbound key, and streams exactly the declared bytes into storage at the edge.
A changed filename or size, a short stream or failed storage write cannot produce
a successful copy receipt. The shared staging code then pulls into the workspace
and records the artifact; follow-ups and child channels use the same capability.
The OAuth credential and file bytes never enter the bot. Without a workspace or
configured storage the file is named as unavailable rather than silently omitted.
Hard Stop carries the run's abort signal through file copies and workspace pulls.
A cancelled copy publishes no artifact receipt and cannot start a model turn.
The edge enables incoming request cancellation and explicitly forwards the signal
to the installation Durable Object, whose download and storage stream share it.
Local development proxies must preserve that cancellation: the Wrangler proxy
currently drops a client disconnect even though direct workerd requests cancel
the copy. Proving or replacing that local transport remains an acceptance gap.

## Proof

| Criterion | Proof |
|---|---|
| Stop racing an unbound dispatch is retained through deferral, renewal, retry and restart without affecting another requester or a newer lease | `[unit]` `src/channels/linear/inbox.test.ts::Linear event inbox — memory::retains Stop across an in-flight no-effects deferral without cancelling another requester`, `src/channels/linear/inbox.test.ts::Linear event inbox — sqlite::retains Stop across an in-flight no-effects deferral without cancelling another requester`, `src/channels/linear/inbox.test.ts::durable Linear event recovery::preserves the queued Stop decision across a retry, a new lease, and host replacement` |
| An authorized Stop prevents a later no-effects deferral from dispatching again, while a new request still runs | `[unit]` `src/channels/linear/consumer.test.ts::Linear event consumer::does not replay a no-effects deferral that finishes after an authorized Stop` |
| Existing queue rows remain usable when deferred-stop tracking is added | `[unit]` `src/channels/linear/inbox.test.ts::durable Linear event recovery::adds the deferred-stop field to an existing queue without cancelling its live delivery` |
| Stop invalidates queued leases only within the authorized session, requester and arrival cutoff, leaving begun work and control events intact | `[unit]` `src/channels/linear/inbox.test.ts::Linear event inbox — memory::cancels only older unbegun requests in the authorized session and invalidates their leases`, `src/channels/linear/inbox.test.ts::Linear event inbox — sqlite::cancels only older unbegun requests in the authorized session and invalidates their leases` |
| Cancelled preparation survives restart and cannot be revived by an acknowledgement | `[unit]` `src/channels/linear/inbox.test.ts::durable Linear event recovery::retains a cancelled preparation across restart and invalidates a pending acknowledgement` |
| A late file response after Stop cannot start the cancelled request, while a new request still runs | `[unit]` `src/channels/linear/consumer.test.ts::Linear event consumer::does not dispatch a file-hydrating request cancelled durably by a later Stop` |
| Queued cancellation uses shared self and channel-wide policy and fails closed on unavailable storage | `[unit]` `src/channels/linear/control.test.ts::Linear stop authorization::authorizes durable queued cancellation through the same self and channel-wide stop rules`, `src/channels/linear/control.test.ts::Linear stop authorization::retries unavailable queued cancellation before acknowledging or stopping active work` |
| The queued-cancellation bridge requires authentication and a bounded, elapsed selection | `[unit]` `src/channels/linear/bridge.test.ts::Linear edge bridge::relays scoped queued cancellation only over the authenticated bridge with an elapsed cutoff` |
| Hard Stop reaches incoming file copies and prevents cancelled file receipts and pulls | `[unit]` `src/core/dispatch/staging.test.ts::staging — copy then pull::passes hard cancellation into a channel copy and never publishes or pulls the cancelled file` |
| A stopped initial copy cannot start the model or pull a workspace file | `[unit]` `src/core/dispatcher.test.ts::inbound staging (record 0033)::a hard stop cancels an admitted file copy before any model turn or workspace pull` |
| The bridge forwards cancellation into the authenticated copy | `[unit]` `src/channels/linear/bridge.test.ts::Linear edge bridge::carries caller cancellation through the bridge request into the active file copy` |
| Local development cancellation crosses the public development proxy and leaves no completed object | `[gap]` Wrangler's development proxy currently drops the caller's disconnect; direct workerd cancellation is verified separately. |
| Staged file copies refresh access, bind session keys, and reject changed or incomplete streams | `[unit]` `src/channels/linear/api.staging.test.ts::Linear workspace file copy::*` |
| The bridge and channel bind file copies to the checked human | `[unit]` `src/channels/linear/bridge.test.ts::Linear edge bridge::relays an attachment copy with the session and human bound separately from file metadata`, `src/channels/linear/io.test.ts::Linear channel output::binds attachment copies to the checked requester and verifies the completed copy` |
| Shared staging retains workspace pulls and receipts for channel copies | `[unit]` `src/core/dispatch/staging.test.ts::staging — copy then pull::uses a channel's private copy while keeping shared workspace pulls and artifact receipts` |
| Incoming staged files retain their message identity and configured budget | `[unit]` `src/channels/linear/consumer.test.ts::Linear event consumer::passes staged metadata and the configured byte budget into dispatch under the original message id`, `src/artifacts/keys.test.ts::key builders (item 20)::normalizes namespaced message ids into one storage segment` |
| Large and binary attachments use bounded references before workspace staging | `[unit]` `src/channels/linear/files.test.ts::Linear private file ingestion::keeps oversized and binary files as bounded staging references without reading their bodies` |
| Cached finished children cannot hide a failed durable question or stop read; retry recovers the question | `[unit]` `src/channels/adminCoordinator.test.ts::coordinator question records::retries a failed durable point read %s while the finished child is still cached` |
| Unanswered coordinator questions respect the unit deadline after restart | `[unit]` `src/core/ship/coordinator.test.ts::coordinator child clarification::ends an unanswered %s question at the unit deadline after restart`, `src/core/ship/coordinator.test.ts::coordinator child clarification::ends a question first observed after the deadline without another sleep` |
| The workflow reports a question deadline and finishes without spawning or merging | `[unit]` `src/core/coordinator/driver.test.ts::coordinator driver clarification::reports an unanswered question's deadline and finishes without another child or merge` |
| A coordinator answer retains the stored task and requester | `[unit]` `src/core/coordinator/clarification.test.ts::coordinator clarification context::*` |
| A coordinator answer rechecks the original preset before starting | `[unit]` `src/core/dispatcher.test.ts::coordinator clarification replies::*` |
| Coordinator question turns do not advance PR or review work | `[unit]` `src/channels/adminCoordinator.test.ts::coordinator question records::*`, `src/core/ship/coordinator.test.ts::coordinator child clarification::*`, `src/core/coordinator/driver.test.ts::coordinator driver clarification::*` |
| Native child creation durability | `[unit]` `src/channels/linear/children.test.ts::*`, `src/channels/linear/api.children.test.ts::*` |
| Child run tools retain clarification as unfinished | `[unit]` `src/tools/runs.test.ts::child clarification stays unfinished::*` |
| Child replies preserve requester isolation | `[unit]` `src/core/dispatch/lineage.test.ts::*` |
| Native child wiring and coordinator access | `[unit]` `src/channels/linear/io.test.ts::Linear channel output::opens an isolated native child with the checked requester and a stable coordinator key`, `src/channels/linear/consumer.test.ts::Linear event consumer::consumes a managed child's creation without a second dispatch but accepts human follow-ups`, `src/channels/linear/bridge.test.ts::Linear edge bridge::relays native child creation with a fixed identity and creation id`, `src/channels/adminCoordinator.test.ts::the plan runner's steps — plan, unit-start, branch, round, unit-end, finish (item 9)::checks the requester before opening coordinator threads and gives each retry a stable channel key` |
| Local origins and run links | `[unit]` `src/channels/startup.test.ts::channel startup::routes Linear intake to a separate local edge while keeping the bot's public origin`, `src/channels/startup.test.ts::channel startup::rejects missing or unsafe Linear bridge configuration before starting the consumer`, `src/channels/linear/bridge.test.ts::Linear edge bridge::accepts local run-page links while rejecting remote plaintext and credential-bearing links` |
| 1–3: OAuth and token lifecycle | `[unit]` `src/channels/linear/oauth.test.ts::*` |
| 4: storage semantics | `[unit]` `src/channels/linear/store.test.ts::*` |
| 5: signature, replay, identity, size and durable-accept boundary | `[unit]` `src/channels/linear/webhook.test.ts::*` |
| 6: real SQLite and in-memory delivery lifecycle, fencing, retry and recovery | `[unit]` `src/channels/linear/inbox.test.ts::*` |
| 7: deployed edge routing | `[agent]` With Linear credentials absent, GET `/oauth/linear/authorize` and POST `/webhooks/linear` return 503. With credentials configured, installation redirects to Linear and callback persists the installation. Send a signed session event while the bot container is stopped; receive 200 and verify the queued delivery after restarting the consumer. The production callback is HTTPS; local testing uses the same path on `http://localhost:8080`. |
| 8: session and human identity | `[unit]` `src/channels/linear/session.test.ts::*` |
| 9: native conversation, progress and replies | `[unit]` `src/channels/linear/io.test.ts::*`, `src/channels/linear/api.test.ts::*` |
| 9: ongoing-work acknowledgement survives a host-generation boundary | `[unit]` `src/core/dispatch/admission.test.ts::admit — the thread admission claim::uses a channel's nonterminal acknowledgement for a follow-up here or on another generation` |
| 10: resolved Linear actor grants | `[unit]` `src/core/authz/actor.test.ts::Linear actor authorization::*` |
| 11: fixed authenticated bridge and durable delivery | `[unit]` `src/channels/linear/bridge.test.ts::*` |
| 12: dispatch consumption, control and recovery | `[unit]` `src/channels/linear/consumer.test.ts::*`, `src/channels/linear/control.test.ts::*`, `src/channels/linear/recovery.test.ts::*` |
| 13: revocation and lifecycle cancellation | `[unit]` `src/channels/linear/lifecycle.test.ts::*` |
| 14: durable acknowledgement and activity reconciliation | `[unit]` `src/channels/linear/acknowledgement.test.ts::*`, `src/channels/linear/inbox.test.ts::*`, `src/channels/linear/api.test.ts::*` |
| 15: private file tickets, session checks and native sharing | `[unit]` `src/channels/linear/api.test.ts::*`, `src/channels/linear/bridge.test.ts::*`, `src/channels/linear/io.test.ts::*` |
| 16: issue actions and delegated queue privacy | `[unit]` `src/channels/linear/workItems.test.ts::*` |
| Work-item tool exposure and dispatcher binding | `[unit]` `src/tools/workItems.test.ts::*`, `src/core/dispatch/runLoop.test.ts::runLoop — the model turn and everything that rides on it::binds work tracking to the resolved requester before a model can call an issue tool` |
| Live large-file staging and deployed installation | `[gap]` Delivery plan acceptance ledger; unit and fixture Worker proofs do not establish a live Linear installation |
| 12: independent channel startup | `[unit]` `src/channels/startup.test.ts::*` |
| Requester isolation before follow-up effects | `[unit]` `src/core/dispatch/admission.test.ts::admit — the thread admission claim::defers another requester without writing either inbox, locally or across generations` |
| Requester-bound execution after deferral | `[unit]` `src/core/dispatcher.test.ts::thread admission (docs/reference/specs/thread-admission.md)::an isolated channel defers another person and later binds a fresh run to that person` |
| 17: current requester access | `[unit]` `src/channels/linear/api.test.ts::Linear API boundary::rechecks the requesting human and current team access before a session can run`, `src/core/dispatcher.test.ts::current channel access before dispatch::*`, `src/core/dispatcher.test.ts::run ledger write-through (docs/reference/specs/run-history.md item 35)::rechecks restored channel access: denials close rows and outages leave them reclaimable` |
| 18: unread prompt feedback | `[unit]` `src/core/dispatcher.test.ts::thread admission (docs/reference/specs/thread-admission.md)::reports an unconsumed follow-up that cannot restart while its access lookup is unavailable` |
| 19: typed question and native delivery | `[unit]` `src/tools/question.test.ts::*`, `src/core/dispatcher.test.ts::clarification through dispatch::*`, `src/channels/linear/io.test.ts::*` |
| 19: final-turn clarification | `[unit]` `src/core/dispatch/runLoop.test.ts::runLoop — the model turn and everything that rides on it::delivers a question from the %s turn without another model turn or automatic publication` |
| 19: stop during final-turn clarification | `[unit]` `src/core/dispatch/runLoop.test.ts::runLoop — the model turn and everything that rides on it::a hard stop during a final question turn clears waiting state without posting a review` |
| 19: question outcome and cleanup | `[unit]` `src/core/dispatch/runLoop.test.ts::runLoop — the model turn and everything that rides on it::keeps a typed question in the turn outcome, receipt and durable run record`, `src/core/dispatch/runLoop.test.ts::runLoop — the model turn and everything that rides on it::ends the model process when a question skips the publishing steps`, `src/core/dispatch/runLoop.test.ts::runLoop — the model turn and everything that rides on it::clears a pending question when a follow-up arrives before the turn finishes` |
| 19: restored questions and stop precedence | `[unit]` `src/core/dispatch/runLoop.test.ts::a resume with the answer in hand (the \`finish\` plan)::restores a pending question without more model calls or automatic PR or review publication`, `src/core/dispatch/runLoop.test.ts::a resume with the answer in hand (the \`finish\` plan)::an operator stop takes precedence over a restored question` |
| 20: durable stop withholds stale coordinator artifacts | `[unit]` `src/channels/adminCoordinator.test.ts::coordinator question records::reports a cancelled question as stopped and withholds its earlier review and PR artifacts` |
| 20: stop while awaiting input | `[unit]` `src/channels/linear/control.test.ts::*` |
| 21: private file ingestion | `[unit]` `src/channels/linear/files.test.ts::*` |
| 21: file identity, transport and turn binding | `[unit]` `src/channels/linear/api.test.ts::*`, `src/channels/linear/bridge.test.ts::*`, `src/channels/linear/io.test.ts::*`, `src/channels/linear/consumer.test.ts::*` |
| 19: review questions survive typed verdict rendering | `[unit]` `src/core/dispatch/reply.test.ts::deliverAnswer — the answer reaches the thread::delivers a review question without formatting an earlier verdict as the answer` |
| 12: run admission before effects | `[unit]` `src/core/dispatcher.test.ts::inbound staging (record 0033)::awaits channel admission before file copies, workspace attach or model execution (%s)`, `src/core/dispatch/commandRun.test.ts::runChatCommand — the machinery moved from the fast path::awaits channel admission and records a stop before executing a command (%s)`, `src/core/dispatch/ship.test.ts::runShipBranch — the agent:ship fork hands every admitted request to the plan runner::awaits channel admission and stops before creating a coordinator (%s)` |
