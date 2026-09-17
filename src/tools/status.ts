// The status card's checklist tool: `update_status` replaces the user-facing
// progress checklist through `ctx.reportProgress`, which the dispatcher binds
// to the card. It mutates the run's own state, so it is never side-effect-free
// and runs strictly in order; a status-only turn does not count against the
// turn guard (docs/reference/specs/harness-pi.md item 5). Relayed to pi like
// every bot tool (docs/reference/specs/harness-pi.md item 7); the toolset
// wiring stays in src/tools/workspace.ts.

import type { RunnableTool } from "./runnableTool.js";

/** The one sentence every call answers with: the card shows the running command
 *  beside the checklist, so a ✓ on an item whose command is still running reads
 *  as a lie — the rule rides on each result, where the model reads it next. */
export const STATUS_RESULT =
  "status updated — keep it truthful: ✓ only for items whose result you have already read, ✱ on the item whose command runs next.";

export const updateStatusTool: RunnableTool = {
  name: "update_status",
  description:
    "Update the short user-facing status checklist shown while you work. " +
    "Call it right after planning (all items pending) and again whenever an item's state changes. " +
    "Format: one item per line, prefixed with a state marker: ✓ done, ✱ in progress, ○ pending. " +
    "The markers are facts, not intentions: mark an item ✱ when you issue the first command that does it, " +
    "and ✓ only after you have read its result — never in the same turn as the command, never because you plan to run it next. " +
    "The card shows the command running right now beside this list, so the two must agree. " +
    "Keep it to 3-6 short outcome-oriented items (what, not how — never raw commands).",
  inputSchema: {
    type: "object",
    properties: {
      checklist: {
        type: "string",
        description: "The full checklist, one '✓|✱|○ item' per line (replaces the previous one)",
      },
    },
    required: ["checklist"],
  },
  async run(input, ctx) {
    ctx.reportProgress?.(String(input.checklist ?? ""));
    return STATUS_RESULT;
  },
};
