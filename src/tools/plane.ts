// The plane's read as a run tool (record 0070; docs/reference/specs/orchestration-plane.md
// item 11): `plane_show` answers the orchestrator preset's fleet questions with
// the SAME rows the `plane show` command, the `/plane` panel and the MCP tool
// carry — one projection, so a row the chat cites is the row the panel paints,
// and a fleet fact never comes from the model's context alone. The tool reads
// through `ToolContext.plane`, a capability the dispatcher binds with the
// REQUESTER's own predicate, so a run sees exactly the rows its person may see.

import { renderPlaneTable } from "../core/commands/plane.js";
import type { JsonValue } from "../core/commandRegistry.js";
import type { PlaneTable } from "../core/plane/table.js";
import type { RunnableTool } from "./runnableTool.js";

/** The plane's table as this run may read it: the one plane service, already
 *  bound to the requester's `runs:read` predicate by the dispatcher. */
export interface PlaneReadCapability {
  table(): Promise<PlaneTable>;
}

const UNAVAILABLE =
  "the plane's tables are not available in this process — say so instead of answering the question from memory.";

export const planeShowTool: RunnableTool = {
  name: "plane_show",
  description:
    "Read the plane's live tables: every live and recently ended run, every ship unit and every tracked pull " +
    "request, each with its owner and its health — the same rows the /plane panels paint. Call it before " +
    "answering ANY question about the fleet, and cite the row you read; a question these tables cannot answer " +
    "is answered 'the tables do not say', never from memory.",
  inputSchema: { type: "object", properties: {} },
  async run(_input, ctx) {
    if (!ctx.plane) return UNAVAILABLE;
    const table = await ctx.plane.table();
    return renderPlaneTable(table as unknown as JsonValue, "chat");
  },
};
