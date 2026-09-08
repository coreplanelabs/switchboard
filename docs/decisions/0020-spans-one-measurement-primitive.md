---
title: A span is the one measurement primitive; every duration a user sees falls out of it
status: implemented
date: 2026-09-08
pattern: Execute Around Method
---

# A span is the one measurement primitive; every duration a user sees falls out of it

## Context

Before this decision the codebase timed things seven ways: `Date.now` pairs sprinkled through the dispatcher, seven duration formatters, two purpose-built timing events on the wire, and a live-status vocabulary on the card that disagreed with the run page's timeline for the same run. Six surfaces showed durations, and they did not agree to the second.

## Decision

One primitive, a span (start, end, name, parent), records every unit of work from the moment a message reaches the process to the moment its first reply lands, plus every named background step and every step on the Workers. Every awaited step runs inside `span(fn)`, so the timeline of a run is a side effect of the code's shape, never a second bookkeeping.

Every instant of a run's window belongs to exactly one of seven terms: getting ready, thinking, in tools, finishing up, Switchboard overhead, not recorded, not loaded. A user can explain every number they see and no gap can hide.

The primitive is node-free with no I/O and an injected clock, so the Workers import it by relative path. `async_hooks` stays out of it behind a `SpanContext` seam whose production implementation is the identity. Direct reads of the clock are held at zero by a ratchet check in `verify`.

Records are written after the run's seal, never before. No span, attribute or log line carries free remote text, a secret or another thread's identifier, and no surface prints a raw span name.

## Consequences

- The six duration surfaces agree because they read one record.
- The two timing events and the seven formatters are gone; the live status card and the run page share one vocabulary.
- Adding a measured step is wrapping it in `span`, and forgetting to is visible as "not recorded" on the timeline rather than as a silent gap.
- Concurrency is not summed: a parent's duration is its own, and children overlapping inside it do not double-count.

## Alternatives rejected

- **Per-surface timers and a separate live-status vocabulary.** The state before.
- **Hooks on a shared tracer.** Couples every module to a global.
- **A trace database and dashboard.** Deferred until an incident question the log lines cannot answer is asked twice.
- **Summing span durations for totals.** Double-counts concurrency.
- **Importing `async_hooks` into the primitive.** Breaks the Workers.

## Pattern

Execute Around Method; Composite for the span tree; Observer for sinks; Decorator and Adapter at the sinks; Ratchet for the clock; Correlation Identifier; Tolerant Reader; Virtual Clock; Null Object for unbound sinks and the identity `SpanContext`; Strategy for the `SpanContext` seam; Collecting Parameter and Unit of Work for the seal-then-write ordering.
