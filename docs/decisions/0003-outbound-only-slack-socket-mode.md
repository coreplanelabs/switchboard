---
title: Slack is reached over Socket Mode, outbound only, and the gaps it leaves are recovered on reconnect
status: implemented
date: 2026-09-08
pattern: Durable record outside the process
---

# Slack is reached over Socket Mode, outbound only, and the gaps it leaves are recovered on reconnect

## Context

A Slack app can receive events two ways: an HTTP endpoint Slack posts to (the Events API, which must acknowledge within three seconds), or a websocket the app opens to Slack (Socket Mode). The bot is one long-lived process that may run anywhere a container runs. Requiring a public URL, TLS termination and request signature verification for that process would decide the hosting story before the product had one.

## Decision

The Slack adapter uses Socket Mode. The bot opens an outbound websocket and hosts no inbound endpoint; "somewhere to run it" is any box that can run a container, with no ingress, load balancer or certificate.

The cost is accepted and paid for explicitly. Socket Mode neither queues nor replays events while the socket is closed, and every rollover closes it: a deploy drains the old container, the socket drops, and the new container cold-starts. Mentions posted in that gap would get no acknowledgement, no run and no reply. So on every `connected` event the adapter scans the channels the bot belongs to and re-dispatches what it never handled ([0012](0012-reconnect-catch-up-as-recovery.md)), and the catch-up window is derived from the drain deadline plus a cold-start allowance so the window always covers the gap a rollover can create.

## Consequences

- Deployment is trivially portable: no public surface exists for the Slack path.
- Recovery after a gap relies on Slack itself as the record of what was handled. Direct messages are not caught up, a window with more than a thousand messages truncates, and a reply broadcast into a channel whose parent is older than the lookback is never seen. Each limit is documented and each fails toward a message staying un-run rather than being silently dropped.
- The drain closes the socket on purpose. A mention accepted at minute fourteen of a fifteen-minute drain would be killed with a frozen status card; letting the catch-up re-run it in the next container is the better outcome.
- Horizontal scale-out of the Slack path is not available in this shape: Socket Mode connections deliver each event to one connection, and the bot is designed as one process ([0016](0016-long-lived-process-not-serverless.md)).

## Alternatives rejected

- **The Events API.** Needs a public URL and a three-second acknowledgement with durable continuation, which is the serverless shape the architecture explicitly defers.
- **Keeping the socket open through the drain.** Accepts work it cannot finish.
- **A persisted last-seen timestamp.** A host-disk marker that an ephemeral container forgets; Slack's own thread state is the durable record.

## Pattern

No catalogue name for the transport choice. The recovery design treats the external system as the durable record so the process itself holds no state a restart loses.
