import type { ToolDef, ToolResultContent } from "../providers/types.js";
import type { Executor } from "../execution/executor.js";
import { shellQuote } from "../execution/shellQuote.js";
import { distillDiff } from "../core/diffDigest.js";
import { webFetchTool, webSearchTool, type WebCapability } from "./web.js";
import { listSkillsTool, useSkillTool } from "./skills.js";
import type { SkillStore } from "../skills/index.js";

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
  /** Skill store backing list_skills/use_skill (#100). Injected by the
   *  dispatcher; absent → the skill tools report themselves unavailable. */
  skills?: SkillStore;
  /** The calling agent's name — scopes list_skills/use_skill so an agent only
   *  sees and loads skills declared for it. */
  agentName?: string;
}

export interface RunnableTool extends ToolDef {
  /** Text for most tools; a parts list when the result should reach the model
   *  as something it can see (image/PDF) — see `ToolResultContent`. */
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResultContent>;
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

// R14: a distilled summary of the branch's diff — per-file churn, totals, and
// risky-file flags — NOT the raw diff. The coding agent includes it in the PR
// body; the review agent uses it to orient. The parse/render lives in the pure
// distillDiff (src/core/diffDigest.ts); this tool only bridges the Executor.
export const diffDigestTool: RunnableTool = {
  name: "diff_digest",
  description:
    "Summarize the current branch's diff against a base ref as a compact digest: per-file +adds/-dels, totals, " +
    "and risky-file flags (migrations/schema, auth/permission, whole-file deletions, lockfiles, very large files). " +
    "This is a DISTILLED summary, not the raw diff — use it to put a diff summary in a PR body, or to orient before a review. " +
    "Runs `git diff <base>...HEAD` in the workspace; base defaults to the repo's default branch (origin/HEAD).",
  inputSchema: {
    type: "object",
    properties: {
      base: {
        type: "string",
        description:
          "Base ref to diff against (e.g. 'main' or a SHA). Defaults to the repo's default branch via origin/HEAD.",
      },
    },
  },
  async run(input, ctx) {
    const base = String(input.base ?? "").trim();
    // git OPTION injection (distinct from shell injection): a base like
    // `--output=/path` or `-O/etc/passwd` is parsed by GIT itself as an option
    // — arbitrary file write/read — even though the shell token is inert. Reject
    // a leading dash, and pass `--end-of-options` so git treats the token as a
    // revision regardless.
    if (base.startsWith("-")) {
      return "diff_digest: base ref may not start with '-' (rejected to prevent git option injection).";
    }
    // Quote a caller-supplied base into one inert shell token so it can't break
    // out of the argument. No base → resolve the default branch at run time,
    // falling back to origin/main when origin/HEAD isn't set.
    const baseExpr = base
      ? shellQuote(base)
      : '"$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo origin/main)"';
    const raw = await ctx.executor.exec(`git diff --end-of-options ${baseExpr}...HEAD`);
    // The Executor returns command failures as text (never throws). If the diff
    // failed, distillDiff would render a misleading "no changes" — surface the
    // error instead.
    if (!raw.includes("diff --git") && /^(exit |fatal:|error:|usage:)/im.test(raw)) {
      return `diff_digest: could not compute the diff (base \`${base || "origin/HEAD"}\`).\n${raw.trim()}`;
    }
    return distillDiff(raw);
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
// #100: the read-only skill tools (list_skills/use_skill) join both the full
// (coding) and readonly (review) toolsets — loading a methodology into context
// never mutates the workspace, so it is safe for the read-only review agent.
export const TOOLSETS: Record<string, RunnableTool[]> = {
  full: [bashTool, readFileTool, writeFileTool, updateStatusTool, webFetchTool, diffDigestTool, listSkillsTool, useSkillTool],
  readonly: [bashTool, readFileTool, updateStatusTool, webFetchTool, diffDigestTool, listSkillsTool, useSkillTool],
  web: [webFetchTool, webSearchTool, updateStatusTool],
  none: [],
};
