---
title: A live run page is opened by an unguessable per-run token; finished runs are read by the policy table
status: implemented
date: 2026-09-08
pattern: Capability-based security
---

# A live run page is opened by an unguessable per-run token; finished runs are read by the policy table

## Context

A status card in Slack links to a page that streams the run as it happens. A plain browser navigation cannot send an `Authorization` header, and the page, its server-sent event stream and its stop control all need the same answer to "may this viewer see this run?"

## Decision

For a live run the token is the capability. `create()` mints a random run id and, separately, a random view token. The link is `/runs/<id>?t=<token>`; the registry validates it in constant time for the page, the stream and the stop control. A wrong or missing token, an unknown run and an expired run share one `404` body, so existence is never revealed. The token is never logged and never appears in any finished row, page or persisted record.

A finished run is served without a token to the authenticated viewer whose actor the policy table ([0007](0007-authorization-policy-table.md)) lets read it. The actor is not consulted for a live run; the token alone decides.

Defense in depth: the whole `/runs*` surface sits behind the dashboard's fail-closed identity gate, and that gate runs before the token check. The `/runs` index is gated by identity only, not by token, and hands run links to anyone who can load it and may read those runs, so it must only ever be exposed behind that gate.

The stream is server-sent events, not a websocket: the flow is one-directional, `EventSource` reconnects on its own, and it needs no handshake or dependency.

## Consequences

- Anyone with the link can watch the run, which is what a link in a shared Slack thread should mean; the identity gate in front bounds "anyone" to the workspace.
- The token's lifetime is the live registry's TTL after seal, so a leaked link stops working on its own.
- Without an identity gate in front (the `none` dashboard auth strategy), the index would hand every live capability link to any visitor. That strategy is therefore only allowed on loopback.

## Alternatives rejected

- **Session cookies for live pages.** Requires a login flow before a link in Slack can be opened, and the viewer may not be a configured actor.
- **Revealing existence on a bad token.** A distinguishable `403` tells an attacker which ids are real.
- **WebSockets.** Bidirectional machinery for a one-way stream.

## Pattern

Capability-based security: possession of the unguessable token is the authorization. Identity-based authorization takes over once the run is durable.
