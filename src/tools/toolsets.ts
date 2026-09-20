// The toolset table: which of the bot's tools a preset's runs hold
// (docs/reference/specs/harness-pi.md item 7). A preset's `toolset` key indexes
// it; every tool here runs in the bot process, relayed from the run's pi with
// the run's own context (`POST /harness/tool`), and is served to pi's extension
// by name, description and schema. The workspace tools a run has — reading,
// editing and writing files, a shell, grep, find, ls — are pi's own and run in
// the run's container; which of them a run holds follows its identity
// (`piBuiltinToolsFor` in src/core/harness/pi/process.ts), never this table.
//
// Until record 0032's series deleted the native loop this table lived in
// src/tools/workspace.ts beside three native workspace tools (`bash`,
// `read_file`, `write_file`) that pi never relayed; the relay filtered them
// out. There is one loop now and no filter: the table is exactly what is
// relayed.

import { attachFileTool } from "./attach.js";
import { planeShowTool } from "./plane.js";
import { diffDigestTool } from "./diffDigest.js";
import { GITHUB_ISSUE_WRITE_TOOLS, GITHUB_READ_TOOLS } from "./github.js";
import type { RunnableTool } from "./runnableTool.js";
import { RUN_TOOLS } from "./runs.js";
import { SESSION_TOOLS } from "./session.js";
import { listSkillsTool, useSkillTool } from "./skills.js";
import { updateStatusTool } from "./status.js";
import { submitDispositionsTool, submitHandoffTool, submitPrDescriptionTool, submitVerdictTool } from "./submit.js";
import { webFetchTool, webSearchTool } from "./web.js";

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
// toolsets of the presets that have a workspace: `full`, `readonly` and
// `explore`. The notepad is the session's own state, not a repository write,
// so the read-only review agent keeps it too.
export const TOOLSETS: Record<string, RunnableTool[]> = {
  full: [
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
  /** The explore agent (docs/reference/specs/agent-explore.md): the web with
   *  search, the skills, the GitHub reads and the status card — and nothing
   *  that writes: no `submit_*`, no issue writes. Its shell and file reads are
   *  pi's own in a cold sandbox; read-only is a toolset-and-prompt contract,
   *  and the wall is the read-scoped credential its machine holds. */
  explore: [
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
  /** The orchestrator (record 0070; docs/reference/specs/orchestration-plane.md
   *  item 11): the plane's read (`plane_show` — the same rows the panels
   *  paint, run rows included), the session tools (the thread's `recall` and
   *  `notes` — the resume ledger rides them) and the status card — and nothing
   *  that writes: no shell, no files, no `submit_*`, no issue writes, and no
   *  run tool (those stay in the conductor toolset alone,
   *  docs/reference/specs/routing-and-config.md item 20). Its writes are the
   *  registry's own commands through the door, never a tool here. */
  orchestrator: [updateStatusTool, planeShowTool, ...SESSION_TOOLS],
  none: [],
};

/** The static toolset plus this run's extra tools (the bridged MCP tools,
 *  docs/reference/specs/mcp-tools.md item 12). A duplicate name is a programming
 *  error (an extra tool shadowing a built-in, or two extras with one name) and
 *  throws before the first model turn. */
export function mergeTools(base: RunnableTool[], extra: RunnableTool[] | undefined): RunnableTool[] {
  if (!extra || extra.length === 0) return base;
  const seen = new Set(base.map((t) => t.name));
  for (const t of extra) {
    if (seen.has(t.name)) throw new Error(`extra tool "${t.name}" collides with an existing tool name`);
    seen.add(t.name);
  }
  return [...base, ...extra];
}
