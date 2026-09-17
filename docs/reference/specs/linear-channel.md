# Linear channel

The installation and intake foundation for a native Linear channel. The
dispatcher adapter is still tracked as a gap below. Its OAuth app is the API
identity; the intended dispatch actor is the authenticated person initiating
the session. Native delegation names the app in `Issue.delegate` and preserves
the human assignee.

- **Code**: `src/channels/linear/oauth.ts`, `src/channels/linear/store.ts`, `src/channels/linear/webhook.ts`, `src/channels/linear/inbox.ts`, `src/core/budgets.ts`, `deploy/cloudflare/linear.ts`, `deploy/cloudflare/worker.ts`, `deploy/cloudflare/wrangler.template.jsonc`.
- **Tests**: `src/channels/linear/oauth.test.ts`, `src/channels/linear/store.test.ts`, `src/channels/linear/webhook.test.ts`, `src/channels/linear/inbox.test.ts`.
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
   failure is retryable and never exposes the payload in the response.
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

## Proof

| Criterion | Proof |
|---|---|
| 1–3: OAuth and token lifecycle | `[unit]` `src/channels/linear/oauth.test.ts::*` |
| 4: storage semantics | `[unit]` `src/channels/linear/store.test.ts::*` |
| 5: signature, replay, identity, size and durable-accept boundary | `[unit]` `src/channels/linear/webhook.test.ts::*` |
| 6: real SQLite and in-memory delivery lifecycle, fencing, retry and recovery | `[unit]` `src/channels/linear/inbox.test.ts::*` |
| 7: deployed edge routing | `[agent]` With Linear credentials absent, GET `/oauth/linear/authorize` and POST `/webhooks/linear` return 503. With credentials configured, installation redirects to Linear and callback persists the installation. Send a signed session event while the bot container is stopped; receive 202 and verify the queued delivery after restarting the consumer. The production callback is HTTPS; local testing uses the same path on `http://localhost:8080`. |
| Native dispatch, activities, recovery, issue actions and deployed installation | `[gap]` Delivery plan acceptance ledger; not implemented by OAuth alone |
