import type { ToolDef } from "../providers/types.js";
import type { Executor } from "../execution/executor.js";
import { webFetchTool, webSearchTool, type WebCapability } from "./web.js";

// Tools are thin declarations over the Executor seam. Where the command
// actually runs (local host vs per-thread sandbox) is the Executor's concern —
// see src/execution/. Web tools are the exception: they do network I/O in the
// bot process via the injected `web` capability, not through the Executor, so a
// no-repo agent can use them with no workspace.

export interface ToolContext {
  executor: Executor;
  /** Replace the user-facing progress checklist on the status card. */
  reportProgress?: (checklist: string) => void;
  /** Web fetch + search capability (Area 5). Injected by the dispatcher;
   *  absent → web tools report themselves unavailable. */
  web?: WebCapability;
}

export interface RunnableTool extends ToolDef {
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export const bashTool: RunnableTool = {
  name: "bash",
  description:
    "Run a bash command in the workspace directory. Use for git, gh, tests, builds, and inspecting files. " +
    "Commands time out after 5 minutes. Output is truncated at 30k characters.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to run" },
    },
    required: ["command"],
  },
  run(input, ctx) {
    return ctx.executor.exec(String(input.command ?? ""));
  },
};

export const readFileTool: RunnableTool = {
  name: "read_file",
  description: "Read a file from the workspace. Path is relative to the workspace root.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path to the file" },
    },
    required: ["path"],
  },
  run(input, ctx) {
    return ctx.executor.readFile(String(input.path ?? ""));
  },
};

export const writeFileTool: RunnableTool = {
  name: "write_file",
  description:
    "Write a file in the workspace (creates parent directories). Path is relative to the workspace root.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path to the file" },
      content: { type: "string", description: "Full file contents" },
    },
    required: ["path", "content"],
  },
  run(input, ctx) {
    return ctx.executor.writeFile(String(input.path ?? ""), String(input.content ?? ""));
  },
};

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

// R16: URL reading (web_fetch) is available broadly to agents with tool loops;
// web_search is gated to the research-capable toolset ("web").
export const TOOLSETS: Record<string, RunnableTool[]> = {
  full: [bashTool, readFileTool, writeFileTool, updateStatusTool, webFetchTool],
  readonly: [bashTool, readFileTool, updateStatusTool, webFetchTool],
  web: [webFetchTool, webSearchTool, updateStatusTool],
  none: [],
};
