# HTTP ingress: authenticated channel adapter #3

The core is channel-agnostic: a channel is only a transport that turns an inbound request into an `IncomingMessage`, calls the core `dispatch()`, and provides a `ChannelIO` to reply through. Slack (adapter #1) and the CLI (adapter #2) already prove this; HTTP is adapter #3 — the same request from an HTTP client reaches the same agents under the same permissions, satisfying the AGENTS.md ≥2-implementations invariant for the channel boundary (first slice of Area 4 / universal ingress, [#45](https://github.com/coreplanelabs/switchboard/issues/45)). MCP ingress is a separate follow-up.

HTTP is single-shot request/response, unlike Slack's long-lived threads. The endpoint is our own service (not behind a platform's auth), so it owns its security in-band: bearer-token auth, **fail-closed**, constant-time compares, identity mapped from the token into the namespaced `IncomingMessage` so the existing `canRunAgent`/`canUseRepo` gates apply unchanged.

- **Code**: `src/channels/http.ts` (`authenticate` pure auth, `handleIngressRequest` transport gating, `HttpIO` single-shot `ChannelIO`, `readBody` size cap, `createIngressHandler` node:http wrapper, `parseIngressTokens` env→config); `src/index.ts` (wires `POST /ingress` into the existing http server alongside the health probe).
- **Tests**: `src/channels/http.test.ts`.
- **Docs**: [AGENTS.md invariants 1, 2, 3, 4](../AGENTS.md), [README — Architecture](../README.md#architecture).

## Behavior

1. **Pure transport, same core.** `POST /ingress` with a JSON body `{ text, channel?, thread?, history? }` becomes an `IncomingMessage` and is handed to the unchanged `dispatch(deps, msg, io)` — no dispatcher, runner, or permission change. Identities are platform-namespaced (invariant 4), mirroring Slack: `userId` = `http:<subject>`, `channelId` = `http:<channel|default>`, `threadKey` = `http:<channel>:<thread|default>`.
2. **Single-shot `ChannelIO`.** `reply()` collects text and the collected text is the HTTP response body (`{ reply }`); `status()` is an honest no-op handle (no live surface to edit in one shot); `history()` replays the optional `history` array from the body, else `[]`.
3. **Bearer auth, fail-closed.** `authenticate(headers, config)` requires `Authorization: Bearer <token>`; a missing, malformed, or unknown token yields `null` → `401`. If **no tokens are configured** the endpoint is **disabled** → `503 {error:"disabled"}`, never open. The map is `token -> { subject, channel? }`; the mapped subject becomes the `userId`, so a token can only ever act as its assigned identity and existing gates apply unchanged. A token may pin a `channel` that overrides the body's channel (locks the config scope).
4. **Constant-time compares, no token logging.** Tokens are compared with `crypto.timingSafeEqual` over equal-length buffers (length guarded first); the loop checks every configured token without short-circuiting, so neither the presence nor the position of a match is a timing oracle. Token material is never logged.
5. **Input hardening.** The body is size-capped at read time (~1 MB, `413` before it is fully buffered); invalid JSON, a non-object body, a missing/blank `text`, or a malformed `history` entry return `400`; a non-POST method returns `405`. Malformed env token config is treated as "no tokens" (disabled), never as open.
6. **Wiring keeps health working.** The `PORT` server routes `/ingress` to the ingress handler and every other path to the existing `ok` health probe. With no tokens configured the startup log says ingress is DISABLED.

## Validation criteria

| Criterion | Evidence |
|-----------|----------|
| Valid token maps to its identity; wrong/unknown/missing/malformed token → null; all tokens checked (position-independent); array header handled | `[unit]` `src/channels/http.test.ts::authenticate (bearer auth, constant-time)::*` |
| Valid request → `dispatch()` called with the correctly namespaced `IncomingMessage`; collected reply returned as `{ reply }` (200) | `[unit]` `::handleIngressRequest (transport gating + dispatch)::valid token → dispatch called with the namespaced IncomingMessage; reply returned` |
| Namespacing: channel/thread defaults; token-pinned channel overrides body | `[unit]` `::defaults channel/thread when the body omits them`, `::a token-pinned channel overrides the body's channel` |
| Fail-closed: no tokens configured → 503 disabled, dispatch never called | `[unit]` `::no tokens configured → 503 disabled, dispatch never called (fail-closed)` |
| Missing/invalid token → 401, dispatch never called | `[unit]` `::missing/invalid token → 401, dispatch never called` |
| Invalid JSON / missing-blank text / bad history → 400; non-POST → 405 | `[unit]` `::invalid JSON → 400, dispatch never called`, `::missing/blank text → 400`, `::malformed history → 400; well-formed history reaches io.history()`, `::non-POST → 405` |
| `HttpIO`: reply collection, no-op status, history replay/default | `[unit]` `::HttpIO (single-shot ChannelIO)::*` |
| Body size cap: reads under cap, rejects over cap; wrapper answers 413 and destroys the request | `[unit]` `::readBody (size cap)::*`, `::createIngressHandler (node:http wrapper)::answers 413 and destroys the request when the body exceeds the cap` |
| node:http wrapper reads body, dispatches, writes 200 JSON | `[unit]` `::createIngressHandler (node:http wrapper)::reads the body, dispatches, and writes a 200 JSON reply` |
| Env→config parsing is fail-closed: valid map parsed; unset/blank/malformed → disabled; malformed entries skipped without opening | `[unit]` `::parseIngressTokens (env → config, fail-closed)::*` |
| Live: an authed `POST /ingress` reaches an agent end-to-end; unauthenticated is refused | `[agent]` (post-deploy) — pending; requires the bot deployed with `SWITCHBOARD_INGRESS_TOKENS` set and `PORT` exposed. |
