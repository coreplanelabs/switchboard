# Linear channel

The native Linear channel's installation, intake and dispatcher adapter.
Its OAuth app is the API identity; the dispatch actor is the authenticated person initiating
the session. Native delegation names the app in `Issue.delegate` and preserves
the human assignee.

- **Code**: `src/channels/linear/oauth.ts`, `src/channels/linear/store.ts`, `src/channels/linear/webhook.ts`, `src/channels/linear/inbox.ts`, `src/channels/linear/api.ts`, `src/channels/linear/session.ts`, `src/channels/linear/io.ts`, `src/channels/linear/bridge.ts`, `src/channels/linear/consumer.ts`, `src/channels/linear/acknowledgement.ts`, `src/channels/linear/control.ts`, `src/channels/linear/recovery.ts`, `src/channels/linear/lifecycle.ts`, `src/index.ts`, `src/core/authz/actor.ts`, `src/core/authz/grants.ts`, `src/core/budgets.ts`, `deploy/cloudflare/linear.ts`, `deploy/cloudflare/worker.ts`, `deploy/cloudflare/wrangler.template.jsonc`.
- **Tests**: `src/channels/linear/oauth.test.ts`, `src/channels/linear/store.test.ts`, `src/channels/linear/webhook.test.ts`, `src/channels/linear/inbox.test.ts`, `src/channels/linear/api.test.ts`, `src/channels/linear/session.test.ts`, `src/channels/linear/io.test.ts`, `src/channels/linear/bridge.test.ts`, `src/channels/linear/consumer.test.ts`, `src/channels/linear/acknowledgement.test.ts`, `src/channels/linear/control.test.ts`, `src/channels/linear/recovery.test.ts`, `src/channels/linear/lifecycle.test.ts`, `src/core/authz/actor.test.ts`.
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
10. Linear human actors use `linear:<workspace>:<user>`. They inherit the same
    open-chat baseline as Slack, plus explicit `linear:*` and personal grants.
    A matching display name or bare user id on another platform or workspace
    never lends the actor that identity's privileges. Team visibility remains
    unknown until proven; it is never treated as public by inference.
11. The internal edge bridge authenticates before parsing a body or claiming
    work. It exposes a fixed delivery/session vocabulary, never arbitrary
    GraphQL or token reads. Each session operation rechecks current access and
    app ownership. Bridge failures return stable errors without upstream text.
12. The consumer durably records entry into dispatch before invoking it. It
    renews each delivery lease while work runs, consumes unrelated sessions
    concurrently, and stops intake during drain. A replay reconciles the
    recorded run or reports an interrupted request; it never blindly repeats
    a command whose effects may already have happened. Pre-dispatch transport
    failures retain their event for retry.
    Turns in one session wait for the prior turn's admission, not its full
    execution. Stop resolves the human actor and uses the existing `runs:write`
    policy; it never stops a later run created after the control event arrived.
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

## Proof

| Criterion | Proof |
|---|---|
| 1–3: OAuth and token lifecycle | `[unit]` `src/channels/linear/oauth.test.ts::*` |
| 4: storage semantics | `[unit]` `src/channels/linear/store.test.ts::*` |
| 5: signature, replay, identity, size and durable-accept boundary | `[unit]` `src/channels/linear/webhook.test.ts::*` |
| 6: real SQLite and in-memory delivery lifecycle, fencing, retry and recovery | `[unit]` `src/channels/linear/inbox.test.ts::*` |
| 7: deployed edge routing | `[agent]` With Linear credentials absent, GET `/oauth/linear/authorize` and POST `/webhooks/linear` return 503. With credentials configured, installation redirects to Linear and callback persists the installation. Send a signed session event while the bot container is stopped; receive 200 and verify the queued delivery after restarting the consumer. The production callback is HTTPS; local testing uses the same path on `http://localhost:8080`. |
| 8: session and human identity | `[unit]` `src/channels/linear/session.test.ts::*` |
| 9: native conversation, progress and replies | `[unit]` `src/channels/linear/io.test.ts::*`, `src/channels/linear/api.test.ts::*` |
| 10: resolved Linear actor grants | `[unit]` `src/core/authz/actor.test.ts::Linear actor authorization::*` |
| 11: fixed authenticated bridge and durable delivery | `[unit]` `src/channels/linear/bridge.test.ts::*` |
| 12: dispatch consumption, control and recovery | `[unit]` `src/channels/linear/consumer.test.ts::*`, `src/channels/linear/control.test.ts::*`, `src/channels/linear/recovery.test.ts::*` |
| 13: revocation and lifecycle cancellation | `[unit]` `src/channels/linear/lifecycle.test.ts::*` |
| 14: durable acknowledgement and activity reconciliation | `[unit]` `src/channels/linear/acknowledgement.test.ts::*`, `src/channels/linear/inbox.test.ts::*`, `src/channels/linear/api.test.ts::*` |
| Issue actions, files and deployed installation | `[gap]` Delivery plan acceptance ledger; not implemented by OAuth alone |
