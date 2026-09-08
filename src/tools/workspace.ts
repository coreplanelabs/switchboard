import { z } from "zod";
import type { ToolDef, ToolResultContent } from "../providers/types.js";
import { parsePrDescription, type PrDescription } from "../core/prDescription.js";
import {
  parseDispositionsInput,
  parseVerdictInput,
  type FindingDisposition,
  type ReviewVerdict,
} from "../core/reviewVerdict.js";
import { BASH_TIMEOUT_MS, bashBudgetWithinRun } from "../execution/bashTimeout.js";
import { clampBashTimeout, type ExecOptions, type Executor } from "../execution/executor.js";
import type { Span } from "../core/trace/types.js";
import { shellQuote } from "../execution/shellQuote.js";
import { distillDiff } from "../core/diffDigest.js";
import { webFetchTool, webSearchTool, type WebCapability } from "./web.js";
import { GITHUB_ISSUE_WRITE_TOOLS, GITHUB_READ_TOOLS, type GithubCapability } from "./github.js";
import { listSkillsTool, useSkillTool } from "./skills.js";
import type { SkillStore } from "../skills/index.js";
import type { RunEvent } from "../core/runEvents.js";

// Tools are thin declarations over the Executor seam. Where the command
// actually runs (local host vs per-thread sandbox) is the Executor's concern —
// see src/execution/. Web tools are the exception: they do network I/O in the
// bot process via the injected `web` capability, not through the Executor, so a
// no-repo agent can use them with no workspace.

export interface ToolContext {
  executor: Executor;
  /** The tool call's own span (docs/reference/specs/tracing.md): what a tool measures
   *  itself (an MCP round trip, an executor op) is a child of it. Absent (CLI,
   *  most unit tests) → the tool measures nothing. */
  span?: Span;
  /** Aborted on a hard run stop. Tools that run something cancellable
   *  (bash → `executor.exec`) pass it through; the runner stops waiting on the
   *  tool regardless, so a tool that ignores it degrades safely. */
  signal?: AbortSignal;
  /** Wall clock left in the run, on the runner's own clock. The bash tool
   *  clips a command's budget to it (minus the write-up reserve), so one
   *  command can never outlive the run. Absent → no clipping (a tool used
   *  outside a run). */
  remainingMs?: () => number;
  /** Replace the user-facing progress checklist on the status card. */
  reportProgress?: (checklist: string) => void;
  /** Web fetch + search capability. Injected by the dispatcher;
   *  absent → web tools report themselves unavailable. */
  web?: WebCapability;
  /** Skill store backing list_skills/use_skill. Injected by the
   *  dispatcher; absent → the skill tools report themselves unavailable. */
  skills?: SkillStore;
  /** GitHub capability behind the `github_*` tools (docs/reference/specs/github-tools.md):
   *  the REST client on the bot's App credential plus the requesting user's
   *  per-repo write gate. Injected by the dispatcher; absent → the tools
   *  report themselves unavailable. */
  github?: GithubCapability;
  /** The calling agent's name — scopes list_skills/use_skill so an agent only
   *  sees and loads skills declared for it. */
  agentName?: string;
  /** Publish a typed event into the run's visibility stream (the same stream
   *  the runner's `tool_call`/`tool_result` go to). For facts a tool knows
   *  that the runner cannot see — which skill was loaded, later which artifact
   *  was produced. Wired by the runner to its `onEvent`; absent (CLI, most
   *  unit tests) → the tool simply does not publish. */
  publish?: (event: RunEvent) => void;
  /** Receives the review agent's structured verdict from `submit_verdict`.
   *  Injected by the dispatcher for review runs; the last call wins. The
   *  dispatcher turns it into the deterministic first line of the GitHub post
   *  (src/core/reviewVerdict.ts). Absent → the tool still accepts the call. */
  onVerdict?: (verdict: ReviewVerdict) => void;
  /** Receives the coding agent's typed PR description from
   *  `submit_pr_description` (docs/reference/specs/pr-description.md). Injected by the
   *  dispatcher for coding runs; the last valid call wins. The dispatcher
   *  renders the GitHub body from it at the pushed head and opens/edits the
   *  PR. Absent → the tool still accepts the call. */
  onPrDescription?: (desc: PrDescription) => void;
  /** Receives a fix round's per-finding dispositions from
   *  `submit_dispositions` (docs/reference/specs/agent-ship.md item 6). Injected by the
   *  ship orchestrator for fix rounds; the last valid call wins. Absent → the
   *  tool still accepts the call. */
  onDispositions?: (dispositions: FindingDisposition[]) => void;
  /** The finding ids from the round's review verdict, for
   *  `submit_dispositions`' known-id check: a disposition naming an id
   *  outside this list is a string error naming it. The tool cannot know the
   *  findings on its own, so validation runs against this list — optional:
   *  when absent (plain coding runs, unit contexts) the id-existence check is
   *  skipped; the ship orchestrator supplies it from the parsed
   *  verdict's findings. */
  knownFindingIds?: string[];
}

export interface RunnableTool extends ToolDef {
  /** Text for most tools; a parts list when the result should reach the model
   *  as something it can see (image/PDF) — see `ToolResultContent`. */
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResultContent>;
  /** True for a tool that only READS (workspace files, the web, skills): when
   *  one assistant turn asks for several of these, the runner executes them
   *  concurrently — on a resident/sandbox each is a network round trip, and
   *  they cannot observe each other. Anything that mutates the workspace
   *  (`bash`, `write_file`) or the run's own state (`update_status`,
   *  `submit_verdict`, `submit_pr_description`, `submit_dispositions`) leaves
   *  this unset and runs strictly in order. */
  sideEffectFree?: true;
}

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

// A distilled summary of the branch's diff — per-file churn, totals, and
// risky-file flags — NOT the raw diff. The coding agent includes it in the PR
// body; the review agent uses it to orient. The parse/render lives in the pure
// distillDiff (src/core/diffDigest.ts); this tool only bridges the Executor.
export const diffDigestTool: RunnableTool = {
  sideEffectFree: true,
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

export const submitVerdictTool: RunnableTool = {
  name: "submit_verdict",
  description:
    "Record your review verdict. REQUIRED before your final message when reviewing a PR: " +
    "`approve` when there are no blocking issues (nits alone are not blocking), `request_changes` otherwise. " +
    "Switchboard writes the verdict as the first line of the GitHub comment itself (`LGTM:` only for approve); " +
    "a review with no submitted verdict is posted as NOT approving. Call it once, after your analysis; a later call replaces the earlier one. " +
    "`head` is the commit you reviewed — run `git rev-parse HEAD` in the checkout you read and tested and pass its output; " +
    "Switchboard posts to the PR only if that commit IS the PR's head, so a review of the wrong branch can never land on a PR. " +
    "Enumerate EVERY issue you report in `findings` with STABLE ids assigned in order (F1, F2, …) — a fix round " +
    "references findings by these ids, so never renumber them. Severity is exactly one of blocking|major|minor|nit; " +
    "the entry carries the file (plus line when it points at one) and a one-line title, while the full explanation " +
    "stays in your review text keyed by the same ids. An `approve` carrying a `blocking` finding is downgraded to " +
    "`request_changes` — approve only when nothing blocking remains.",
  inputSchema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approve", "request_changes"], description: "approve | request_changes" },
      summary: { type: "string", description: "One-line rationale shown right after the verdict token" },
      head: {
        type: "string",
        description: "Output of `git rev-parse HEAD` in the checkout you reviewed (the commit the review is about)",
      },
      findings: {
        type: "array",
        description: "Every issue you report, one entry each, in the order reported — rendered under the verdict line",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: 'Stable id assigned in order: "F1", "F2", … — dispositions reference it',
            },
            severity: {
              type: "string",
              enum: ["blocking", "major", "minor", "nit"],
              description: "blocking | major | minor | nit",
            },
            file: { type: "string", description: "Repo-relative file the finding points at" },
            line: { type: "integer", description: "1-based line number, when the finding points at one" },
            title: {
              type: "string",
              description: "One line naming the issue (the full explanation goes in your review text)",
            },
          },
          required: ["id", "severity", "file", "title"],
        },
      },
    },
    required: ["verdict", "summary", "head"],
  },
  async run(input, ctx) {
    const verdict = parseVerdictInput(input);
    if (!verdict) return "error: verdict must be exactly `approve` or `request_changes`";
    ctx.onVerdict?.(verdict);
    const notes: string[] = [];
    if (verdict.findings) notes.push(`${verdict.findings.length} finding${verdict.findings.length === 1 ? "" : "s"}`);
    if (verdict.droppedFindings?.length) notes.push(`dropped: ${verdict.droppedFindings.join("; ")}`);
    return notes.length
      ? `verdict recorded: ${verdict.verdict} (${notes.join("; ")})`
      : `verdict recorded: ${verdict.verdict}`;
  },
};

// The fix round's answer to the review's findings (docs/reference/specs/agent-ship.md
// item 6): one typed disposition per finding, so the ship orchestrator can
// split a cap report into declined (disposition recorded) vs unaddressed
// (none). Validation mirrors submit_verdict's fail-closed style — the parse
// lives beside the findings in src/core/reviewVerdict.ts. The tool cannot
// know the round's findings on its own: the known-id check runs against
// `ToolContext.knownFindingIds` when the orchestrator supplies it, and is
// skipped when absent.
export const submitDispositionsTool: RunnableTool = {
  name: "submit_dispositions",
  description:
    "Record one disposition per review finding after addressing them: `fixed` (the finding is addressed in your " +
    "pushed code) or `declined` (deliberately not doing it — the note says why). `findingId` is the finding's " +
    "stable id from the review (F1, F2, …) — use exactly those ids; an unknown id is rejected by name. Every " +
    "finding gets exactly one entry, every severity included (nits too). Call it once with the complete set after " +
    "your last push; a later call replaces the earlier one. Dispositions are recorded only inside a ship " +
    "pipeline's fix round; anywhere else the call is an honest no-op that says nothing was recorded.",
  inputSchema: {
    type: "object",
    properties: {
      dispositions: {
        type: "array",
        description: "The complete set — one entry per finding from the review",
        items: {
          type: "object",
          properties: {
            findingId: { type: "string", description: 'The finding\'s stable id from the review (e.g. "F1")' },
            disposition: { type: "string", enum: ["fixed", "declined"], description: "fixed | declined" },
            note: { type: "string", description: "One line: what was done, or why it was declined" },
          },
          required: ["findingId", "disposition", "note"],
        },
      },
    },
    required: ["dispositions"],
  },
  async run(input, ctx) {
    const parsed = parseDispositionsInput(input);
    if (!parsed) return "error: dispositions must be an array of { findingId, disposition: fixed|declined, note }";
    if (ctx.knownFindingIds) {
      const known = new Set(ctx.knownFindingIds);
      const unknown = [...new Set(parsed.dispositions.map((d) => d.findingId).filter((id) => !known.has(id)))];
      if (unknown.length) {
        return `error: unknown finding id${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} — use exactly the ids from the review's findings list`;
      }
    }
    // No sink means no ship fix round is listening (docs/reference/specs/agent-ship.md
    // item 6): a "recorded" ack here would be a false success the model
    // relays to the user — say the truth instead.
    if (!ctx.onDispositions)
      return "no ship fix round is active here — dispositions were not recorded (they apply only when addressing a ship review's findings)";
    ctx.onDispositions(parsed.dispositions);
    const drops = parsed.dropped.length ? ` (dropped: ${parsed.dropped.join("; ")})` : "";
    return `dispositions recorded: ${parsed.dispositions.length}${drops}; a later call replaces this one`;
  },
};

// The coding agent's PR deliverable (docs/reference/specs/pr-description.md): a typed
// PrDescription instead of hand-written markdown. The dispatcher renders the
// GitHub body from the submitted object at the pushed head and opens/edits
// the PR itself, so the loop's ground truth comes from code, never from prose.
// Validation mirrors submit_verdict: a schema violation comes back as a
// readable string error naming the failing path — never a throw — so the
// model can fix the object and call again within its own budget.
export const submitPrDescriptionTool: RunnableTool = {
  name: "submit_pr_description",
  description:
    "Submit the PR description as a typed object. REQUIRED after pushing your branch: Switchboard renders the " +
    "GitHub PR body from this object at the pushed head and opens (or updates) the pull request itself — never " +
    "open a PR yourself. Fields map 1:1 to the rendered sections; `title` becomes the PR's title; tour anchors " +
    "are (path, from, to) line ranges at your pushed head. Call it after your last push; if you push again " +
    "afterwards, call it again — the last valid call wins. An invalid object returns an error naming the field " +
    "to fix; correct it and resubmit.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "The PR title — one line naming the change" },
      tldr: {
        type: "string",
        description: "Two sentences for a naive reader with zero context: what and why it matters",
      },
      whatWhy: {
        type: "string",
        description: "The change and its motivation, with the triggering issue/request hyperlinked",
      },
      tour: {
        type: "array",
        description: "Reader-first walkthrough steps in reading order (load the pr-tour skill first)",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "What this change is" },
            description: { type: "string", description: "The explanation the reader needs before seeing the code" },
            lookFor: { type: "string", description: "Optional pointer at the detail worth checking" },
            anchor: {
              type: "object",
              description: "The hunk: repo-relative path + inclusive 1-based line range at the pushed head",
              properties: {
                path: { type: "string" },
                from: { type: "integer" },
                to: { type: "integer" },
              },
              required: ["path", "from", "to"],
            },
          },
          required: ["title", "description", "anchor"],
        },
      },
      remaining: {
        type: "array",
        description:
          "Every touched file the Tour steps did not cover, one note each ([] when the Tour covers everything)",
        items: {
          type: "object",
          properties: { path: { type: "string" }, note: { type: "string" } },
          required: ["path", "note"],
        },
      },
      decisions: {
        type: "array",
        description: "Non-obvious choices: alternatives considered and rejected, trade-offs",
        items: {
          type: "object",
          properties: { title: { type: "string" }, rationale: { type: "string" } },
          required: ["title", "rationale"],
        },
      },
      risks: { type: "string", description: 'What could break and the blast radius (or "none" — and why)' },
      validation: {
        type: "object",
        description: "What you actually ran and the real results — never fabricated",
        properties: {
          summary: { type: "string", description: "Optional one-line overall result" },
          criteria: {
            type: "array",
            items: {
              type: "object",
              properties: { criterion: { type: "string" }, proof: { type: "string" } },
              required: ["criterion", "proof"],
            },
          },
        },
        required: ["criteria"],
      },
    },
    required: ["title", "tldr", "whatWhy", "tour", "remaining", "decisions", "risks", "validation"],
  },
  async run(input, ctx) {
    let desc: PrDescription;
    try {
      desc = parsePrDescription(input);
    } catch (err) {
      const detail =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
          : String(err);
      return `error: invalid PR description — ${detail}`;
    }
    ctx.onPrDescription?.(desc);
    return `PR description recorded (title: ${desc.title}). Switchboard renders the body at your pushed head and opens or updates the PR; a later call replaces this one.`;
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

// URL reading (web_fetch) is available broadly to agents with tool loops;
// web_search is gated to the research-capable toolset ("web").
// The read-only skill tools (list_skills/use_skill) join both the full
// (coding) and readonly (review) toolsets — loading a methodology into context
// never mutates the workspace, so it is safe for the read-only review agent.
// submit_pr_description and submit_dispositions are full-only: only the coding
// agent ships PRs and answers review findings, the way submit_verdict is
// readonly-only because only the review agent judges them.
// docs/reference/specs/github-tools.md: the GitHub READ tools (repos, files, trees, code
// search, issue list/get) join every toolset with a tool loop — they need no
// workspace and let any agent answer from the org's repos. The issue WRITE
// tools (create/update/comment/delete) go where the agent may act on GitHub:
// `assistant` (general) and `full` (coding); the read-only review agent and
// the research agent never mutate GitHub.
export const TOOLSETS: Record<string, RunnableTool[]> = {
  full: [
    bashTool,
    readFileTool,
    writeFileTool,
    updateStatusTool,
    submitPrDescriptionTool,
    submitDispositionsTool,
    webFetchTool,
    diffDigestTool,
    listSkillsTool,
    useSkillTool,
    ...GITHUB_READ_TOOLS,
    ...GITHUB_ISSUE_WRITE_TOOLS,
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
  ],
  web: [webFetchTool, webSearchTool, updateStatusTool, ...GITHUB_READ_TOOLS],
  /** The general agent: no workspace, no shell — GitHub reads + issue writes
   *  and URL reading, so a plain mention can answer from the repos and act on
   *  issues without being re-sent to another agent. */
  assistant: [webFetchTool, updateStatusTool, ...GITHUB_READ_TOOLS, ...GITHUB_ISSUE_WRITE_TOOLS],
  none: [],
};
