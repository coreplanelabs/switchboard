# Live run view

You can watch an agent run in real time from a browser. When a run starts, the bot mints an unguessable link (`<PUBLIC_BASE_URL>/runs/<id>?t=<token>`) and puts it on the in-channel status card; opening it streams the SAME redacted run events the card shows — each tool call and its ✓/✗ result summary — as they happen, over Server-Sent Events. This is Area 2's external live UI ([#43](https://github.com/coreplanelabs/switchboard/issues/43)), built on the run-visibility stream ([run-visibility.md](run-visibility.md)).

**In-memory, live-only (locked design).** A run's events live in an in-memory registry only while the run is active, plus a bounded per-run backlog so a viewer who opens the link mid-run sees what already happened. Finished runs stay viewable for a short TTL, then are evicted. Persisting/replaying past runs is out of scope (Area 7). This ephemeral state is intentional under AGENTS.md invariant 6: a restart ends the runs it was streaming and nothing durable is lost.

**Auth = per-run capability token (locked design).** A plain browser navigation can't send an `Authorization` header, so auth is an unguessable per-run token carried in the URL, validated (constant-time) by the registry for BOTH the page and the SSE stream. A wrong/missing token — or an unknown/evicted run — is a **404** (existence is never revealed). The token is the capability: unguessable, scoped to one run, never logged.

**Transport = SSE (locked design).** The flow is strictly one-directional (server → page), `EventSource` auto-reconnects, and it needs no handshake or extra dependency — so SSE over a WebSocket. The page is a single self-contained HTML document (inline CSS/JS, no external/CDN assets) under a strict CSP; event summaries are rendered with `textContent`, never `innerHTML`. Events are already redacted + capped upstream ([runEvents.ts](../src/core/runEvents.ts)); this layer adds no data and re-exposes nothing.

- **Code**: [`src/core/runRegistry.ts`](../src/core/runRegistry.ts) (`RunRegistry`: `create`/`publish`/`finish`/`subscribe`/`has`, bounded backlog, TTL eviction, constant-time token gate, `defaultRunRegistry` singleton); [`src/channels/liveView.ts`](../src/channels/liveView.ts) (`parseRunRoute`, `renderRunPage`, `serveEvents`, `createLiveViewHandler`); [`src/core/dispatcher.ts`](../src/core/dispatcher.ts) (registers the run, publishes events in `onEvent`, finishes in the run-loop `finally`, adds the link to the status card when `PUBLIC_BASE_URL` is set); [`src/index.ts`](../src/index.ts) (routes `GET /runs/:id` + `/runs/:id/events`, sharing `defaultRunRegistry` with the dispatcher).
- **Tests**: [`src/core/runRegistry.test.ts`](../src/core/runRegistry.test.ts), [`src/channels/liveView.test.ts`](../src/channels/liveView.test.ts), [`src/core/dispatcher.test.ts`](../src/core/dispatcher.test.ts) (`live run-view wiring (Area 2)`).
- **Docs**: [AGENTS.md invariants 1, 2, 6](../AGENTS.md), [run-visibility.md](run-visibility.md).

## Behavior

1. **Per-run capability.** `RunRegistry.create()` mints a random run id and a random view token (default: `randomUUID` + 32 random bytes as hex). The dispatcher creates one run per agent run and finishes it when the run ends.
2. **Live stream + backlog replay.** `publish(id, event)` fans an event out to live subscribers and appends it to a bounded per-run backlog (default 1000 events; oldest evicted). A subscriber that arrives mid-run replays the backlog in order, then live-forwards new events.
3. **Constant-time token gate, 404 on failure.** `subscribe`/`has` compare the presented token against the run's token with `crypto.timingSafeEqual` over equal-length buffers (length guarded first). A wrong/missing token or unknown run yields `null`/`false` → the handlers answer **404** for both the page and the stream. The token is never logged.
4. **Finish + TTL eviction.** `finish(id)` notifies live subscribers (SSE `end` frame → the page closes its `EventSource`), stops further forwarding, and starts the eviction TTL (default 60s). A viewer who opens the link after finish but within the TTL sees the full backlog then `end`. After the TTL the run is evicted (subscribe → 404). Unfinished runs are never evicted by age. Eviction is lazy (swept on registry activity) — no background timer keeps the process alive.
5. **SSE handler.** `GET /runs/:id/events?t=…` sets `content-type: text/event-stream` (+ `no-cache`, `x-accel-buffering: no`), writes the 200 head, then flushes the replayed backlog and live events as `data:` frames; the terminal `end` event closes the stream. A client disconnect unsubscribes. The backlog replay (synchronous during `subscribe`) is buffered until after the 200 head so no frame is written before the status line.
6. **Self-contained page.** `GET /runs/:id?t=…` serves a minimal HTML page (inline CSS/JS, strict CSP, `no-store`, `noindex`) that opens the token-scoped `EventSource` and renders `tool_call` → a running row and `tool_result` → ✓/✗ + summary, via `textContent` only. Both routes are GET-only (405 otherwise).
7. **Graceful degradation.** The dispatcher reads `PUBLIC_BASE_URL` from the env. Set → the live link (`<base>/runs/<id>?t=<token>`, trailing slash trimmed) is added to the status card while the run is live. Unset/blank → no link is added; the run, the card, and every other surface work unchanged. The registry always runs (so a run is always streamable if someone has the link) — only the surfaced link depends on the base URL.

## Validation criteria

| Criterion | Evidence |
|-----------|----------|
| `create()` mints distinct, unguessable id + token; defaults are crypto-random | `[unit]` `src/core/runRegistry.test.ts::RunRegistry.create::*` |
| Live subscriber receives published events in order | `[unit]` `::subscribe — token gate (constant-time capability)::delivers published events to a live subscriber` |
| Wrong/missing token and unknown run are rejected (null), nothing delivered; `has()` mirrors the gate | `[unit]` `::rejects a wrong token …`, `::rejects a missing/empty token`, `::rejects an unknown run id …`, `::has() mirrors the same constant-time gate …` (token gate red-verified: removing the compare fails these) |
| Late subscriber replays backlog in order, then live-forwards | `[unit]` `::backlog replay for a late subscriber::replays already-published events, in order, then live-forwards new ones` |
| Backlog is bounded to the most recent N | `[unit]` `::bounds the backlog: only the most recent N events are retained for replay` |
| Unsubscribe stops delivery | `[unit]` `::unsubscribe::stops delivery after unsubscribe` |
| Finish notifies live subscribers and stops forwarding; post-finish subscriber replays then gets onFinish; publish to unknown run is a no-op | `[unit]` `::finish::*` |
| Finished run evicted after TTL (subscribe → null); unfinished never evicted by age | `[unit]` `::finished-run eviction after TTL::*` |
| Route parsing: page vs events, id decode, rejects non-run/empty/malformed | `[unit]` `src/channels/liveView.test.ts::parseRunRoute::*` |
| Page references the token-scoped EventSource URL; self-contained (no external assets); textContent only; id/token URL-encoded safely | `[unit]` `::renderRunPage::*` |
| SSE: 404 on rejected subscribe; sets `text/event-stream` + forwards data frames; backlog flushed after the 200 head; `end` frame on finish; already-finished replays then ends; unsubscribe on client close | `[unit]` `::serveEvents (SSE, transport-free)::*` |
| Handler: falls through non-run paths; serves page (CSP) for valid token; 404s page + stream on bad token; streams SSE; 405 on non-GET | `[unit]` `::createLiveViewHandler (node:http)::*` |
| Dispatcher registers the run, publishes each event, finishes it in `finally` | `[unit]` `src/core/dispatcher.test.ts::live run-view wiring (Area 2)::registers the run, publishes its events, and finishes it` |
| Live link on the status card when `PUBLIC_BASE_URL` set; omitted (no crash) when unset | `[unit]` `::puts the per-run capability link on the status card when PUBLIC_BASE_URL is set`, `::omits the link entirely when PUBLIC_BASE_URL is unset …` |
| Live end-to-end: open the link in a browser during a real run and watch tool calls/results stream, ✓/✗ per result; a wrong `t=` gives 404; the stream closes when the run finishes | `[agent]` (post-deploy) — pending; requires the bot deployed with `PUBLIC_BASE_URL` set and `PORT` exposed. |
