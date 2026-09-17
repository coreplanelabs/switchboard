# Linear channel

The native Linear channel's installation, intake and dispatcher adapter.
Its OAuth app is the API identity; the dispatch actor is the authenticated person initiating
the session. Native delegation names the app in `Issue.delegate` and preserves
the human assignee.

- **Code**: `src/channels/startup.ts`, `src/core/dispatch/reply.ts`, `src/channels/linear/files.ts`, `src/channels/attachmentTypes.ts`, `src/channels/linear/oauth.ts`, `src/channels/linear/store.ts`, `src/channels/linear/webhook.ts`, `src/channels/linear/inbox.ts`, `src/channels/linear/api.ts`, `src/channels/linear/session.ts`, `src/channels/linear/io.ts`, `src/channels/linear/bridge.ts`, `src/channels/linear/consumer.ts`, `src/channels/linear/acknowledgement.ts`, `src/channels/linear/control.ts`, `src/channels/linear/recovery.ts`, `src/channels/linear/lifecycle.ts`, `src/channels/linear/workItems.ts`, `src/channels/linear/access.ts`, `src/core/dispatch/channelAccess.ts`, `src/core/question.ts`, `src/tools/question.ts`, `src/core/workItems.ts`, `src/tools/workItems.ts`, `src/tools/toolsets.ts`, `src/tools/runnableTool.ts`, `src/core/dispatch/runLoop.ts`, `src/core/authz/policy.ts`, `src/index.ts`, `src/core/authz/actor.ts`, `src/core/authz/grants.ts`, `src/core/budgets.ts`, `deploy/cloudflare/linear.ts`, `deploy/cloudflare/worker.ts`, `deploy/cloudflare/wrangler.template.jsonc`.
- **Tests**: `src/channels/startup.test.ts`, `src/core/dispatch/reply.test.ts`, `src/channels/linear/files.test.ts`, `src/channels/linear/oauth.test.ts`, `src/channels/linear/store.test.ts`, `src/channels/linear/webhook.test.ts`, `src/channels/linear/inbox.test.ts`, `src/channels/linear/api.test.ts`, `src/channels/linear/session.test.ts`, `src/channels/linear/io.test.ts`, `src/channels/linear/bridge.test.ts`, `src/channels/linear/consumer.test.ts`, `src/channels/linear/acknowledgement.test.ts`, `src/channels/linear/control.test.ts`, `src/channels/linear/recovery.test.ts`, `src/channels/linear/lifecycle.test.ts`, `src/channels/linear/workItems.test.ts`, `src/tools/workItems.test.ts`, `src/tools/question.test.ts`, `src/core/dispatch/runLoop.test.ts`, `src/core/authz/actor.test.ts`.
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

20. A Stop with no authorized active run does not post a completion or progress
    activity that could change another person's session. It can close the newest
    waiting question only through the shared stop policy and only if the question
    predates the Stop. An older question cannot hide a newer invisible run. A
    missing history snapshot retries rather than guessing whether a question waits.

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

## Proof

| Criterion | Proof |
|---|---|
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
| Large inbound file staging and deployed installation | `[gap]` Delivery plan acceptance ledger; inline file support does not prove these |
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
| 20: stop while awaiting input | `[unit]` `src/channels/linear/control.test.ts::*` |
| 21: private file ingestion | `[unit]` `src/channels/linear/files.test.ts::*` |
| 21: file identity, transport and turn binding | `[unit]` `src/channels/linear/api.test.ts::*`, `src/channels/linear/bridge.test.ts::*`, `src/channels/linear/io.test.ts::*`, `src/channels/linear/consumer.test.ts::*` |
| 19: review questions survive typed verdict rendering | `[unit]` `src/core/dispatch/reply.test.ts::deliverAnswer — the answer reaches the thread::delivers a review question without formatting an earlier verdict as the answer` |
