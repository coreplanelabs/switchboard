---
title: Bound response validation off the gateway event loop
status: superseded
superseded_by: 0096-keep-the-proxy-thin-and-decode-once-in-the-harness.md
date: 2026-10-05
pattern: Bulkhead isolation and backpressure
---

# Bound response validation off the gateway event loop

## Context

The gateway serves HTTP, channel connections and cancellation on one event loop. Yielding before an SDK event does not interrupt expensive work inside that event. Retaining incomplete stream data one character at a time also increases allocation pressure.

## Decision

Keep response frame JSON decoding and the existing SDK consuming function in a built-in Node worker for each call. Bound active validators and waiting callers. Admit one operation at a time and await the SDK's original consumption acknowledgement before forwarding its event.

Append SSE data in bounded slices and yield between them. Preserve framing, client bytes, SDK inputs, state, first failures and terminal ordering. Keep signing, hosted-effect guards, usage, prices and request caps in the gateway.

Use the caller's original cancellation signal and native stream abort notification. Stop queued and active validation independently of a pending write, SDK completion or stream flush. Reuse a capacity slot only after actual worker exit. Validator interruption remains local uncertainty and grants no provider recovery or retry.

## Consequences

Workers are ephemeral CPU resources, not run controllers or durable business owners. They receive no provider credential or signing key. The original time, turn and cost accounting remains in place.

Worker startup, IPC and retained SDK assembly still cost CPU and memory. Heap limits do not constrain total RSS, external buffers or shared CPU quota. Other provider paths remain separate. SDK prefix parsing and duplicate assembly are unchanged; their removal requires a canonical SDK consuming API with equivalent behavior.

## Alternatives

Yielding alone cannot contain one expensive SDK event. A child process adds address-space isolation and packaging overhead while still sharing the container's CPU budget. A local replacement parser or argument projection creates another interpretation of provider output and is rejected.
