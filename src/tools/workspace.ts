import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ToolDef } from "../providers/types.js";

// Tools execute inside a per-conversation workspace directory. Every path is
// resolved and confined to the workspace root; bash gets the workspace as cwd.

export interface ToolContext {
  workspaceDir: string;
}

export interface RunnableTool extends ToolDef {
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

function confine(root: string, p: string): string {
  const abs = resolve(root, p);
  if (abs !== root && !abs.startsWith(root + "/")) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return abs;
}

const BASH_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT = 30_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n...[truncated ${s.length - MAX_OUTPUT} chars]` : s;
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
    const command = String(input.command ?? "");
    return new Promise((res) => {
      execFile(
        "bash",
        ["-c", command],
        { cwd: ctx.workspaceDir, timeout: BASH_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const parts = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
          if (err) {
            res(truncate(`exit ${(err as NodeJS.ErrnoException & { code?: number }).code ?? "error"}: ${err.message}\n${parts}`));
          } else {
            res(truncate(parts || "(no output)"));
          }
        },
      );
    });
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
  async run(input, ctx) {
    const p = confine(ctx.workspaceDir, String(input.path ?? ""));
    return truncate(readFileSync(p, "utf8"));
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
  async run(input, ctx) {
    const p = confine(ctx.workspaceDir, String(input.path ?? ""));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(input.content ?? ""));
    return `Wrote ${input.path}`;
  },
};

export const TOOLSETS: Record<string, RunnableTool[]> = {
  full: [bashTool, readFileTool, writeFileTool],
  readonly: [bashTool, readFileTool],
  none: [],
};

export function ensureWorkspace(baseDir: string, key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const dir = join(resolve(baseDir), safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}
