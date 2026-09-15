// The native tool table and the three workspace tools pi never relays. `bash`,
// `read_file` and `write_file` reach the workspace through the Executor seam
// for the native loop; on the pi harness pi's own tools do that work inside the
// container, so these three are exactly the tools the relay leaves out
// (docs/reference/specs/harness-pi.md item 7). `TOOLSETS` is the table a
// preset's `toolset` key indexes — which tools a run holds — read by the native
// loop and by the relay alike. Everything else that lived here outlives this
// file: the tool contract (`ToolDef`, `ToolContext`, `RunnableTool`) in
// ./runnableTool.ts and the relayed tools in ./diffDigest.ts, ./submit.ts and
// ./status.ts. What remains is deleted with the native loop at the last step
// of record 0032's series (docs/decisions/0032-pi-is-the-harness-the-native-loop-retires.md).

import { BASH_TIMEOUT_MS, bashBudgetWithinRun } from "../execution/bashTimeout.js";
import { clampBashTimeout, type ExecOptions } from "../execution/executor.js";
import { attachFileTool } from "./attach.js";
import { diffDigestTool } from "./diffDigest.js";
import { GITHUB_ISSUE_WRITE_TOOLS, GITHUB_READ_TOOLS } from "./github.js";
import type { RunnableTool } from "./runnableTool.js";
import { RUN_TOOLS } from "./runs.js";
import { SESSION_TOOLS } from "./session.js";
import { listSkillsTool, useSkillTool } from "./skills.js";
import { updateStatusTool } from "./status.js";
import { submitDispositionsTool, submitHandoffTool, submitPrDescriptionTool, submitVerdictTool } from "./submit.js";
import { webFetchTool, webSearchTool } from "./web.js";

export const bashTool: RunnableTool = {
  name: "bash",
  description:
    "Run a bash command in the workspace directory. Use for git, gh, tests, builds, and inspecting files. " +
    "Commands time out after 5 minutes (300000 ms) by default; pass timeoutMs when a command legitimately needs " +
    "longer — a full test suite, a large build — up to the 1200000 ms (20 minute) maximum; a command is " +
    "also clipped to the run's own remaining time, so it can never outlive the run. " +
    "Output is truncated at 30k characters.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to run" },
      timeoutMs: {
        type: "integer",
        description:
          "Optional timeout in milliseconds for this command (default 300000 = 5 min; max 1200000 = 20 min). " +
          "Values outside [1000, 1200000] are clamped.",
      },
    },
    required: ["command"],
  },
  async run(input, ctx) {
    // A finite number is clamped to [1s, 20 min] (clampBashTimeout); anything
    // else is dropped so executors run on the 5-minute default — no timeoutMs
    // in the input is byte-for-byte the pre-timeoutMs call.
    const requested = input.timeoutMs;
    let timeoutMs =
      typeof requested === "number" && Number.isFinite(requested) ? clampBashTimeout(requested) : undefined;
    // …then clipped to the run's remaining wall clock (docs/reference/specs/execution.md
    // item 12): a command may never outlive the run it serves, and inside the
    // write-up reserve nothing starts at all.
    let clipNote = "";
    if (ctx.remainingMs) {
      const budget = bashBudgetWithinRun(timeoutMs ?? BASH_TIMEOUT_MS, ctx.remainingMs());
      if (budget.kind === "exhausted") return `exit 124:\n${budget.note}`;
      if (budget.kind === "clipped") {
        timeoutMs = budget.timeoutMs;
        clipNote = budget.note;
      }
    }
    const opts: ExecOptions = {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
    const out = await ctx.executor.exec(
      String(input.command ?? ""),
      opts.signal !== undefined || opts.timeoutMs !== undefined ? opts : undefined,
    );
    return clipNote ? `${out}\n${clipNote}` : out;
  },
};

export const readFileTool: RunnableTool = {
  sideEffectFree: true,
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
  description: "Write a file in the workspace (creates parent directories). Path is relative to the workspace root.",
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

// URL reading (web_fetch) is available broadly to agents with tool loops;
// web_search is gated to the research-capable toolset ("web").
// The read-only skill tools (list_skills/use_skill) join both the full
// (coding) and readonly (review) toolsets — loading a methodology into context
// never mutates the workspace, so it is safe for the read-only review agent.
// submit_pr_description, submit_handoff and submit_dispositions are full-only:
// only the coding agent ships PRs, hands off and answers review findings, the
// way submit_verdict is readonly-only because only the review agent judges them.
// docs/reference/specs/github-tools.md: the GitHub READ tools (repos, files, trees, code
// search, issue list/get) join every toolset with a tool loop — they need no
// workspace and let any agent answer from the org's repos. The issue WRITE
// tools (create/update/comment/delete) go where the agent may act on GitHub:
// `assistant` (general) and `full` (coding); the read-only review agent and
// the research agent never mutate GitHub.
// attach_file (docs/reference/specs/agent-coding.md item 10) is full-only: the
// coding agent is the one that renders screenshots and PDFs worth showing; it
// posts into the conversation, so it never joins a read-only toolset.
// The session tools (docs/reference/specs/session-log.md item 10) — `recall`
// over the thread-and-agent log and `notes`, the session's notepad — join the
// toolsets of the presets that have a workspace and so can run on the pi
// harness: `full`, `readonly` and `explore`. The notepad is the session's own
// state, not a repository write, so the read-only review agent keeps it too.
export const TOOLSETS: Record<string, RunnableTool[]> = {
  full: [
    bashTool,
    readFileTool,
    writeFileTool,
    attachFileTool,
    updateStatusTool,
    submitPrDescriptionTool,
    submitHandoffTool,
    submitDispositionsTool,
    webFetchTool,
    diffDigestTool,
    listSkillsTool,
    useSkillTool,
    ...GITHUB_READ_TOOLS,
    ...GITHUB_ISSUE_WRITE_TOOLS,
    ...SESSION_TOOLS,
  ],
  readonly: [
    bashTool,
    readFileTool,
    updateStatusTool,
    submitVerdictTool,
    webFetchTool,
    diffDigestTool,
    listSkillsTool,
    useSkillTool,
    ...GITHUB_READ_TOOLS,
    ...SESSION_TOOLS,
  ],
  web: [webFetchTool, webSearchTool, updateStatusTool, ...GITHUB_READ_TOOLS],
  /** The general agent: no workspace, no shell — GitHub reads + issue writes
   *  and URL reading, so a plain mention can answer from the repos and act on
   *  issues without being re-sent to another agent. */
  assistant: [webFetchTool, updateStatusTool, ...GITHUB_READ_TOOLS, ...GITHUB_ISSUE_WRITE_TOOLS],
  /** The explore agent (docs/reference/specs/agent-explore.md): a shell and
   *  file reads in a cold sandbox, the web with search, the skills and the
   *  GitHub reads — and nothing that writes: no `write_file`, no `submit_*`,
   *  no issue writes. Read-only is a toolset-and-prompt contract; the wall is
   *  the read-scoped credential its machine holds. */
  explore: [
    bashTool,
    readFileTool,
    updateStatusTool,
    webFetchTool,
    webSearchTool,
    listSkillsTool,
    useSkillTool,
    ...GITHUB_READ_TOOLS,
    ...SESSION_TOOLS,
  ],
  /** The conductor (docs/reference/specs/agent-conductor.md): the five run
   *  tools — the only toolset that holds them, so no other preset can start,
   *  steer or await a run — beside the GitHub reads, URL reading and the status
   *  card. No shell, no files, no writes: a conductor coordinates and never
   *  does a child's job. */
  conductor: [...RUN_TOOLS, webFetchTool, updateStatusTool, ...GITHUB_READ_TOOLS],
  none: [],
};
