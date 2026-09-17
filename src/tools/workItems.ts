import type { RunnableTool } from "./runnableTool.js";
import type { WorkItemRequest } from "../core/workItems.js";

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  request: (input: Record<string, unknown>) => WorkItemRequest,
  read = false,
): RunnableTool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    ...(read ? { sideEffectFree: true as const } : {}),
    failsInText: true,
    async run(input, ctx) {
      if (!ctx.workItems) return "error: work-item tools are not available in this conversation";
      try {
        return JSON.stringify(await ctx.workItems.request(request(input)));
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : "work-item request failed"}`;
      }
    },
  };
}
const str = { type: "string" };
const id = { type: "string", description: "Issue identifier or ID, such as ENG-123" };

export const WORK_ITEM_READ_TOOLS = [
  tool(
    "work_item_get",
    "Read an issue in this conversation's work tracker, including status, human assignee and delegated agent. Access is limited to the requesting person's visible teams.",
    { id },
    ["id"],
    (i) => ({ op: "get", id: i.id as string }),
    true,
  ),
  tool(
    "work_items_delegated",
    "List issues delegated to Switchboard that the requesting person can access. This lists the delegated agent, not the human assignee. Follow nextCursor with after to read later pages.",
    { after: str, limit: { type: "integer", minimum: 1, maximum: 50 } },
    [],
    (i) => ({ op: "delegated", after: i.after as string | undefined, limit: i.limit as number | undefined }),
    true,
  ),
];
export const WORK_ITEM_WRITE_TOOLS = [
  tool(
    "work_item_update",
    "Update only the issue fields requested. Preserve the human assignee and delegated agent. A completed agent run or an open PR does not mean the issue is Done; change status only when the requested work warrants it. Needs the work-items:write grant.",
    {
      id,
      title: str,
      description: str,
      priority: { type: "integer", minimum: 0, maximum: 4 },
      state: { type: "string", description: "Exact team status name or ID" },
    },
    ["id"],
    (i) => ({
      op: "update",
      id: i.id as string,
      title: i.title as string | undefined,
      description: i.description as string | undefined,
      priority: i.priority as number | undefined,
      state: i.state as string | undefined,
    }),
  ),
  tool(
    "work_item_create_child",
    "Create a subissue in its parent's team. Does not assign a person or automatically delegate another agent run. Needs the work-items:write grant.",
    { parentId: id, title: str, description: str },
    ["parentId", "title"],
    (i) => ({
      op: "create_child",
      parentId: i.parentId as string,
      title: i.title as string,
      description: i.description as string | undefined,
    }),
  ),
  tool(
    "work_item_comment",
    "Post a requested comment on an issue the person can access. Use ordinary conversation replies for progress; use this for durable issue notes or a requested PR link. Needs the work-items:write grant.",
    { id, body: str },
    ["id", "body"],
    (i) => ({ op: "comment", id: i.id as string, body: i.body as string }),
  ),
];
