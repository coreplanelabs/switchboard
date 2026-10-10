---
title: Keep the proxy thin and decode once in the harness
status: superseded
superseded_by: 0098-bound-stream-concurrency-separately-from-parsing.md
date: 2026-10-09
pattern: Thin streaming proxy and bounded full-response concurrency
---

# Keep the proxy thin and decode once in the harness

## Context

A review asks the model to read code and return a verdict. The proxy controls access and transports the provider response; the harness turns that response into model text and tool calls. The gateway added a second copy of the harness SDK decoder. That copy retained output and repeatedly parsed tool arguments before the harness parsed them again. A local decoder refusal could therefore stop a review before its real decoder read the response.

## Decision

Decode model semantics once, in the harness's existing SDK. The gateway keeps authorization, model and turn pins, bounded JSON and wire framing, signed provider failures, transport usage and resource safety. It does not build model output, parse tool arguments or judge the review task.

Retain the current two active and two queued full-response reservations. A queued body is unread and spends no model turn. Keep the slot until the request, original source cancellation, parser worker exit and actual HTTP finish or close settle. These fixed values are compatibility limits; this decision does not claim they were sized by a production workload study.

Keep the existing stream backpressure and authenticated failure-ending adapter. A direct Node `pipeline()` replacement can destroy an HTTP socket before the gateway sends its signed failure. Removing the duplicate decoder does not require changing correct disposal plumbing.

A validated completed provider terminal plus clean source EOF, without an earlier wire/resource fatal or caller abort, proves provider transport availability. It does not prove harness SDK acceptance, a completed model turn, a tool result or a published review. Usage names the provider-wire frames the gateway actually admitted; a later fatal makes prior usage partial, and unread or conflicting later usage earns no credit. The existing signed allowlist and hosted-effect restrictions still govern provider-down evidence; no new retry or ending authority follows.

Delete the gateway SDK accumulator, argument-prefix parsing, consume/close IPC and only the storage charges for that removed state. Reuse the existing bounded neutral JSON worker. All byte, graph, storage, heap, time, grant and cancellation limits remain unchanged. No new parser, service, scheduler, client ACK or tracing system is introduced.

## Consequences

A bounded JSON event can be forwarded even if the harness SDK rejects its model semantics. The harness records that task failure; the gateway must not invent a provider failure from it. Existing tests must distinguish transport evidence from SDK and task outcomes, rather than requiring both layers to share one verdict.

The duplicate work is removed. Full-stream occupancy, genuine upstream delay and retained source cancellation can still fill the unchanged pool. This change does not establish the occupants or initiating cause of a historical capacity refusal. Staging and natural complete reviews remain separate delivery proofs.

## References and alternatives

[LiteLLM per-worker admission control](https://docs.litellm.ai/docs/proxy/server_tuning#per-worker-admission-control) bounds active requests and a queue for the whole stream. This is the reference pattern, not LiteLLM router deployment routing. Its limits, queue timeout and retry behavior are not adopted.

[Node stream lifecycle guidance](https://nodejs.org/download/release/v22.23.3/docs/api/stream.html#streampipelinesource-transforms-destination-callback) describes standard backpressure and disposal, and warns that HTTP pipeline errors can destroy the socket before an error reply.

Adding occupancy note types before simplifying the duplicated work would grow a custom control design. Replacing the SDK with a second semantic parser or a new acceptance ACK would preserve that duplication under another name. Both are rejected.
