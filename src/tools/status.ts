// The status card's checklist tool: `update_status` replaces the user-facing
// progress checklist through `ctx.reportProgress`, which the dispatcher binds
// to the card. It mutates the run's own state, so it is never side-effect-free
// and runs strictly in order; a status-only turn does not count against the
// turn guard (docs/reference/specs/harness-pi.md item 5). Relayed to pi like
// every bot tool (docs/reference/specs/harness-pi.md item 7); the toolset
// wiring stays in src/tools/workspace.ts.

import type { RunnableTool } from "./runnableTool.js";

export const updateStatusTool: RunnableTool = {
  name: "update_status",
  description:
    "Update the short user-facing status checklist shown while you work. " +
    "Call it right after planning (all items pending) and again whenever an item's state changes. " +
    "Format: one item per line, prefixed with a state marker: ✓ done, ✱ in progress, ○ pending. " +
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
    return "status updated";
  },
};
