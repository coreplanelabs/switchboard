import type { RunEvent } from "./runEvents.js";

// The live status card's transient title suffix (features/run-visibility.md
// item 2): what the run has been waiting on since its last event, once that
// wait is long enough to be worth a word. Pure, so the two answers — the
// model is thinking, or a tool is running — are asserted apart from the
// dispatcher. When the last event WAS a tool call, a long quiet stretch is a
// wait on the sandbox, not on the model: an hour-long `pnpm typecheck` must
// never render as `thinking (3601s since last tool)`.

/** A quiet stretch shorter than this gets no suffix: the activity line
 *  already shows the current call, and a few seconds of either kind of wait
 *  is not news. */
export const QUIET_SUFFIX_AFTER_MS = 20_000;

/** The suffix for a run that last emitted an event `quietMs` ago: nothing
 *  inside QUIET_SUFFIX_AFTER_MS; ` — running <tool> (Ns)` while a tool call
 *  has no result yet (the wait is the tool's, however long — the executor's
 *  deadline, not the model, ends it); ` — thinking (Ns since last tool)`
 *  otherwise (the wait is the model's turn). */
export function quietSuffix(quietMs: number, inFlightTool?: string): string {
  if (quietMs <= QUIET_SUFFIX_AFTER_MS) return "";
  const secs = Math.round(quietMs / 1000);
  return inFlightTool ? ` — running ${inFlightTool} (${secs}s)` : ` — thinking (${secs}s since last tool)`;
}

/** The tool in flight after `e`: a `tool_call` opens one, its `tool_result`
 *  closes it, every other event leaves it as it was. The runner emits the two
 *  strictly in pairs, so one name (not a set) is the whole state. */
export function inFlightToolAfter(current: string | undefined, e: RunEvent): string | undefined {
  if (e.type === "tool_call") return e.tool;
  if (e.type === "tool_result") return undefined;
  return current;
}
