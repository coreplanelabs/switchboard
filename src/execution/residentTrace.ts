// The bot's side of the resident's step trace (docs/reference/specs/tracing.md item 19):
// an Anti-Corruption Layer at the parse boundary. Whatever the resident sent
// is rebuilt field by field from an allowlist — names sanitized, numbers
// finite and clamped, status a literal, error text dropped — and then grafted
// under the span that made the call, rebased to that span's start and clipped
// to now, so a skewed, oversized, orphaned, mis-named or hostile trace can
// only ever produce fewer, shorter, plainly-named spans.

import type { Span } from "../core/trace/types.js";
import type { SpanAttrs } from "../core/trace/attrs.js";
import { sanitizeStepName, STEP_TRACE_MAX, STEP_TRACE_MAX_BYTES, type ResidentStep } from "./residentStepTrace.js";

/** Every step the resident's answer carries, made safe. Anything that is not a
 *  well-formed step is dropped; the list is bounded like the Worker's. */
export function sanitizeGraftedSteps(raw: unknown): ResidentStep[] {
  if (!Array.isArray(raw)) return [];
  const out: ResidentStep[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (!finite(r.startMs) || !finite(r.durationMs)) continue;
    const step: ResidentStep = {
      name: sanitizeStepName(r.name),
      startMs: Math.max(0, Math.round(r.startMs)),
      durationMs: Math.max(0, Math.round(r.durationMs)),
      status: r.status === "error" ? "error" : "ok",
    };
    if (finite(r.exitCode) && Number.isInteger(r.exitCode) && r.exitCode >= 0 && r.exitCode <= 255) {
      step.exitCode = r.exitCode;
    }
    if (r.timedOut === true) step.timedOut = true;
    if (finite(r.waitedMs)) step.waitedMs = Math.max(0, Math.round(r.waitedMs));
    out.push(step);
    if (out.length > STEP_TRACE_MAX) out.shift();
  }
  while (out.length > 0 && JSON.stringify(out).length > STEP_TRACE_MAX_BYTES) out.shift();
  return out;
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** The steps a failed request ran, pinned on the error it became. */
export interface ResidentTrace {
  steps: ResidentStep[];
  residentMs?: number;
}

const TRACE_OF = new WeakMap<object, ResidentTrace>();

/** Pin a failed request's sanitized steps on the error that reports it, so a
 *  caller that catches the error (or wraps it as a `cause`) can still graft
 *  them: a failed attach's trace is the one that says which step blew the
 *  budget. Returns the same error. */
export function withResidentTrace<E extends object>(err: E, trace: ResidentTrace): E {
  TRACE_OF.set(err, trace);
  return err;
}

/** The trace pinned on `err` or on one of its causes (to depth 5), if any. */
export function residentTraceOf(err: unknown): ResidentTrace | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && typeof cur === "object" && cur !== null; depth++) {
    const found = TRACE_OF.get(cur);
    if (found) return found;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export interface GraftInput {
  /** The span that made the call (`dispatch.workspace.attach`, `run.command`). */
  parent: Span;
  /** The graft prefix: the parent's own name, so the steps read `<parent>.<step>`. */
  prefix: "dispatch.workspace.attach" | "run.command" | "resident";
  /** The bot's stamp for the request's start — the parent span's start. */
  baseAt: number;
  /** The bot's now: no grafted span ends after it. */
  clipAt: number;
  /** The resident's own total for the request (`attachMs`, `durationMs`), for
   *  `clockSkewMs`: the bot's wait minus this, signed (negative = the clocks
   *  disagree). */
  residentTotalMs?: number;
}

/** Graft sanitized steps under the parent: each becomes `<prefix>.<name>`,
 *  rebased so the resident's request start is the parent's start and clipped
 *  to `clipAt`. Returns how many landed. `clockSkewMs` — the difference between
 *  what the bot saw and what the resident measured (network and overhead) —
 *  goes on the parent. */
export function graftResidentSteps(steps: readonly ResidentStep[], input: GraftInput): number {
  const { parent, prefix, baseAt, clipAt } = input;
  let grafted = 0;
  for (const step of steps) {
    const startedAt = Math.min(clipAt, baseAt + step.startMs);
    const endedAt = Math.min(clipAt, startedAt + step.durationMs);
    const attrs: SpanAttrs = {
      backend: "resident",
      ...(step.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
      ...(step.timedOut ? { timedOut: true } : {}),
      ...(step.waitedMs !== undefined ? { waitedMs: step.waitedMs } : {}),
    };
    parent.graft(`${prefix}.${step.name}`, {
      startedAt,
      endedAt,
      status: step.status,
      attrs,
      ...(step.status === "error" ? { errorKind: "infra" as const } : {}),
    });
    grafted++;
  }
  if (input.residentTotalMs !== undefined) {
    // Signed on purpose: negative when the resident measured more than the bot
    // waited, i.e. the two clocks disagree — as worth seeing as the overhead.
    parent.setAttrs({ clockSkewMs: Math.max(0, clipAt - baseAt) - Math.max(0, input.residentTotalMs) });
  }
  return grafted;
}
