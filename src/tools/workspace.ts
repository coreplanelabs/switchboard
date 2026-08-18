import type { ToolDef } from "../providers/types.js";
import type { Executor } from "../execution/executor.js";

// Tools are thin declarations over the Executor seam. Where the command
// actually runs (local host vs per-thread sandbox) is the Executor's concern —
// see src/execution/.

export interface ToolContext {
  executor: Executor;
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

export const TOOLSETS: Record<string, RunnableTool[]> = {
  full: [bashTool, readFileTool, writeFileTool],
  readonly: [bashTool, readFileTool],
  none: [],
};
