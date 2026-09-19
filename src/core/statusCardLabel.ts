import type { RunEvent } from "./runEvents.js";

// The live status card's transient title suffix (docs/reference/specs/run-visibility.md
// item 2): what the run has been waiting on since its last event, once that
// wait is long enough to be worth a word. Pure, so the three answers — the
// model is thinking, a tool is running, or a tool has outrun its own bound
// (docs/reference/specs/live-view.md item 32) — are asserted apart from the
// dispatcher. When the last event WAS a tool call, a long quiet stretch is a
// wait on the sandbox, not on the model: an hour-long `pnpm typecheck` must
// never render as `thinking (3601s since last tool)`.

/** The tool call in flight after the last event, as the card tracks it: the
 *  tool's name and the bound the call itself declared (`tool_call.boundMs`),
 *  when it did. */
export interface InFlightTool {
  tool: string;
  boundMs?: number;
}

/** A quiet stretch shorter than this gets no suffix: the activity line
 *  already shows the current call, and a few seconds of either kind of wait
 *  is not news. */
export const QUIET_SUFFIX_AFTER_MS = 20_000;

/** The suffix for a run that last emitted an event `quietMs` ago: nothing
 *  inside QUIET_SUFFIX_AFTER_MS; ` — <tool> <N>s, bound <B>s` once a call has
 *  run past the bound it declared — the hung call is marked, never shown as
 *  ordinary progress (live-view item 32); ` — running <tool> (Ns)` while a
 *  tool call has no result yet (the wait is the tool's, however long — the
 *  executor's deadline, not the model, ends it); ` — thinking (Ns since last
 *  tool)` otherwise (the wait is the model's turn). */
export function quietSuffix(quietMs: number, inFlight?: InFlightTool): string {
  if (quietMs <= QUIET_SUFFIX_AFTER_MS) return "";
  const secs = Math.round(quietMs / 1000);
  if (!inFlight) return ` — thinking (${secs}s since last tool)`;
  if (inFlight.boundMs !== undefined && quietMs > inFlight.boundMs) {
    return ` — ${inFlight.tool} ${secs}s, bound ${Math.round(inFlight.boundMs / 1000)}s`;
  }
  return ` — running ${inFlight.tool} (${secs}s)`;
}

/** The call in flight after `e`: a `tool_call` opens one — the declared bound
 *  riding along — its `tool_result` closes it, every other event leaves it as
 *  it was. The runner emits the two strictly in pairs, so one call (not a set)
 *  is the whole state. */
export function inFlightCallAfter(current: InFlightTool | undefined, e: RunEvent): InFlightTool | undefined {
  if (e.type === "tool_call") return { tool: e.tool, ...(e.boundMs !== undefined ? { boundMs: e.boundMs } : {}) };
  if (e.type === "tool_result") return undefined;
  return current;
}
