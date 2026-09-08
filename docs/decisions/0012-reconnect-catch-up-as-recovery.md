---
title: Slack itself is the record of what was handled; every reconnect replays what it never saw
status: implemented
date: 2026-09-08
pattern: External system as durable record
---

# Slack itself is the record of what was handled; every reconnect replays what it never saw

## Context

Socket Mode queues nothing while the socket is closed ([0003](0003-outbound-only-slack-socket-mode.md)), and the bot's disk is ephemeral. A mention posted during a rollover, or a run killed between its acknowledgement and its first reply, would otherwise vanish with no trace beyond the person waiting. Two incidents set the shape: a review's status card froze at "153 s, thinking" for good when the process was killed, and a mention sat unacknowledged for seven and a half minutes through a drain, indistinguishable to the caller from being ignored.

## Decision

On every websocket `connected`, first start and each reconnect alike, the adapter scans every channel the bot is a member of and re-dispatches what it never handled, through the same `handle()` a live event takes. "Handled" is read from Slack, never from local state: the bot posted in the thread after the mention, or the mention carries the bot's 👀 reaction and is younger than a short grace period. A 👀 alone on an older message means a run that died between the acknowledgement and its card, so it is re-run.

The window is thirty minutes, floored at the drain deadline plus a cold-start allowance so a configured window can never be shorter than the gap a rollover creates. Older unanswered mentions are left alone: re-running a stale request is worse than the person re-posting it. A replayed message says so in its thread.

The same scan sweeps orphaned status cards, because a card is the only durable trace of a run that died. Cards this process owns are never touched, so a reconnect without a restart cannot close a running run's card, and cards older than two hours are left alone rather than mislabeled.

Every bound fails toward a message staying un-run, never toward a silent drop.

## Consequences

- The process holds no "last seen" state, so an ephemeral container forgets nothing that matters.
- Direct messages are not caught up; a window with more than a thousand messages truncates; a broadcast reply whose parent is older than the seven-day lookback is never seen. Each is documented as a known limit.
- A configured window below the floor is kept as given and warned about at startup, never silently clamped.
- With the durable ledger ([0019](0019-durable-run-ledger-resume-after-kill.md)) the sweep consults the live-runs list before closing a card, so a run resumed by the new container keeps its card.

## Alternatives rejected

- **Keeping the socket open during the drain.** Accepts a mention at minute fourteen that the fifteen-minute cap then kills with a frozen card.
- **A persisted last-seen timestamp.** Host-disk state on a host that has no durable disk.
- **Treating 👀 as terminal.** Made a reply vanish when the process died eight seconds after acknowledging.

## Pattern

The external system is the durable record; the process is stateless with respect to what it has handled.
