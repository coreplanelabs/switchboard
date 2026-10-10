---
title: Bound stream concurrency separately from parsing
status: proposed
date: 2026-10-09
pattern: Bounded concurrency and FIFO backpressure
---

# Bound stream concurrency separately from parsing

## Context

A model exchange spends much of its lifetime waiting on a provider. Holding one of two parser slots for that entire exchange rejects ordinary concurrent threads. Increasing that count alone also fails: each parser and complete frame reserves temporary working space against the existing shared storage budget.

## Decision

Keep the thin proxy and single harness decoder from [decision 0096](0096-keep-the-proxy-thin-and-decode-once-in-the-harness.md). Admit up to 32 whole-response exchanges and queue up to 128 unread requests in FIFO order. This target covers five engineers with four simultaneous threads each, plus twelve exchanges of headroom. It is a fixed workload target, not a claim about historical usage or arbitrary payloads.

Use the existing semaphore for a separate one-permit parsing pool. Acquire its permit before temporary parsing, request preparation, frame-field and output reservations; return it after that short operation settles. Failed parsing retains its permit until the worker exits. Provider waiting and HTTP delivery retain the transport reservation but do not occupy a parsing permit. Keep all existing byte, graph, worker heap and aggregate storage limits. Use the existing Cloudflare singleton at `standard-2` (one vCPU,6GiB): the repeatable half-vCPU team run completed every call but failed the one-second health guard; both profiles passed at the larger quota. This changes the source sizing, not the deployed service.

Bound each queue wait at 30 seconds. Timeout removes only that waiter; it never releases active work. Caller cancellation also removes queued work. An active transport remains occupied until request processing, source cancellation, worker exit and actual HTTP delivery finish. No request is replayed. Authentication, turn and time budgets remain unchanged.

Show a queued exchange as "waiting for model capacity" in its run trace. Record sanitized admission and actual-release counts with the run identity. An authenticated pre-body capacity refusal names the local capacity failure and grants no provider recovery authority.

Before changing the limits, run both `npm run load -- model-capacity` profiles and compare their receipts with the [recorded baselines](../reference/benchmarks/model-capacity/README.md). Keep failed runs and distinguish changed settings from changed hardware.

## Consequences

The fixed stream target needs finite qualification against the deployed CPU and memory quota. Twenty ordinary simultaneous threads must complete through both buffered and streaming paths, with exact response bytes and no leaked reservations. Resource maxima remain refusal boundaries: admitting a stream does not promise room for every simultaneous maximal payload. Local and emulated qualification remain separate from staging and natural production acceptance.

Adaptive concurrency is deferred until sustained usage supplies a baseline. The admission pool belongs to the bot proxy and is independent of the executor, resident and Sandbox lifecycle. The planned Sandbox v2 migration remains separate; this change adds no SDK scheduling or alarm owner.

## Alternatives

[Cloudflare Queues](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) provides at-least-once delivery, and [does not guarantee ordering](https://developers.cloudflare.com/queues/reference/how-queues-works/). Moving a live model HTTP exchange there would require new durable replay and response-routing rules. A separate Durable Object would likewise move coordination away from the process whose CPU and memory this gate protects. Neither is needed for this bounded local pool.

Removing the cap leaves finite resources unprotected. Enlarging only the waiting queue absorbs bursts but cannot supply throughput. Retaining a separate short parsing permit lets network concurrency increase without granting every stream simultaneous parser working space.
