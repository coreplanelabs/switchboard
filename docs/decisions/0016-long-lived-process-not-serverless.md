---
title: One long-lived bot process plus Durable Objects for what must survive it, not a serverless runtime
status: implemented
date: 2026-09-08
pattern: State outside the process
---

# One long-lived bot process plus Durable Objects for what must survive it, not a serverless runtime

## Context

Everything about the Workers platform invites a serverless design: an HTTP handler per Slack event, state in Durable Objects, no process to keep alive. Switchboard runs instead as one long-lived container. The question "why not serverless-native?" comes up often enough to deserve a record.

## Decision

Switchboard is one long-lived process, the bot, plus three Cloudflare Workers, each earning its place by solving a problem the bot structurally cannot: the state Worker holds Durable Objects for everything that must survive a restart; the resident Worker holds checkouts and their credential ([0009](0009-residents-second-credential-domain.md)); the sandbox Worker runs untrusted commands. The bot is the only thing that must run continuously, and everything it depends on is designed so that the bot restarting or redeploying loses nothing.

Not serverless-native, for now, because the Slack adapter is a Socket Mode daemon ([0003](0003-outbound-only-slack-socket-mode.md)) and a run holds a model conversation, a sandbox attach and a Slack card open for minutes. The seams map one-to-one onto the durable-agent frameworks that productize the serverless shape, so that door stays open, and there is no reason to pay for it before horizontal scale matters.

The strongest form of the alternative was argued in full and deferred: run each agent run inside a Durable Object with the bot as a thin Slack adapter. It would remove the lease, handoff and reclaim protocol whose only reason to exist is a mortal process. Against it, and decisive: it moves the provider key, the GitHub App key and the Slack token into a Worker, changing every trust boundary the topology codifies; the Durable Object runner still needs the transcript persisted under the same two-megabyte row limit, and fifty live transcripts share one isolate's memory; and a Durable Object alarm has a fifteen-minute wall-clock ceiling, so a run would have to re-enter per step anyway, which is the same machinery the durable-runs design builds.

## Consequences

- Hosting is any box that runs a container, with the Workers as managed dependencies.
- The bot's disk is ephemeral, so anything that must survive a restart lives in a Durable Object by rule (the "state survives restarts" invariant).
- The bot is a single process: concurrency is bounded by its admission control and its container size, not by scale-out. That is the accepted ceiling until it is measured to matter.
- If the Durable Object runner is wanted later, the ledger and transcript design of [0019](0019-durable-run-ledger-resume-after-kill.md) is what it would build on.

## Alternatives rejected

- **HTTP Events API with durable continuation.** The serverless shape; deferred, not refused.
- **A Durable Object per run.** Deferred with the argument above; it remains the later end state if scale demands it.

## Pattern

State outside the process. The process is disposable; the Durable Objects are the memory.
