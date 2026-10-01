import type { RunEvent } from "./runEvents.js";

/** A verified private main DM's source data stays in its requester-scoped model session.
 * Its run page and live stream are shared diagnostic surfaces, so they carry
 * only structural progress until a separate audience-aware reader exists. */
export function privateMainEvent(event: RunEvent): RunEvent {
  const at = event.at;
  const seq = event.seq;
  switch (event.type) {
    case "input":
      return { type: "input", text: "Private request", messageId: event.messageId, at, seq };
    case "answer":
      return { type: "answer", text: "See the private conversation for the answer.", at, seq };
    case "context":
    case "assistant":
    case "notes":
      return { type: event.type, text: "Private conversation activity", at, seq };
    case "tool_call":
      return {
        type: "tool_call",
        tool: "private_read",
        summary: "Checking a private source",
        callId: event.callId,
        at,
        seq,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool: "private_read",
        ok: event.ok,
        summary: "Private source check finished",
        callId: event.callId,
        at,
        seq,
      };
    case "run_state":
      return {
        type: "run_state",
        state: event.state,
        since: event.since,
        ...(event.bound !== undefined ? { bound: event.bound } : {}),
        ...(event.cause !== undefined ? { cause: event.cause } : {}),
        detail: "Private conversation activity",
        at,
        seq,
      };
    case "span_start":
      return {
        type: "span_start",
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        name: "private activity",
        at,
        seq,
      };
    case "span_end":
      return {
        type: "span_end",
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        name: "private activity",
        startedAt: event.startedAt,
        durationMs: event.durationMs,
        status: event.status,
        at,
        seq,
      };
    case "lease":
      return event;
    case "run_note":
      if (event.kind === "work_source_refused" && event.sourceReason)
        return {
          type: "run_note",
          kind: "work_source_refused",
          summary: "Private work source refused.",
          sourceReason: event.sourceReason,
          at,
          seq,
        };
      return { type: "run_note", kind: "follow_up", summary: "Private conversation activity", at, seq };
    default:
      return { type: "run_note", kind: "follow_up", summary: "Private conversation activity", at, seq };
  }
}
