import {
  ACTIONS_LOG_MAX_CHARS,
  GithubApiError,
  type ActionsJob,
  type GithubApi,
  type IssueSummary,
} from "../execution/githubApi.js";
import { redactSecrets, stripAnsi } from "../core/redact.js";
import type { RunnableTool } from "./runnableTool.js";

// The `github_*` tools (docs/reference/specs/github-tools.md): every agent with a tool
// loop can read the org's repositories and read/write their issues through the
// bot's own GitHub App credential — in the bot process over REST (invariant 5),
// with no workspace, so the no-repo `general` and `research` agents can answer
// "how does X in our repo work?" and "open an issue on Y" without a clone.
//
// Reads are `sideEffectFree` (the runner may run several from one turn
// concurrently); the issue writes are not, and each one is gated by
// `ctx.github.canWrite(repo)` — the caller's per-repo permission
// (`restrict.repos` + the `repos` grant, open unless restricted), resolved by the dispatcher for
// the requesting user, so a tool can never write to a repo the user may not use.
// Tools return strings for errors — never throw — so the model can recover in
// budget; a 404 is worded as what it usually is: a repo outside the App
// installation, or a path/number that does not exist.

/** What the dispatcher injects: the API and the requesting user's write gate. */
export interface GithubCapability {
  api: GithubApi;
  /** True when the requesting user may write to `repo` (`canUseRepo`: open unless `restrict.repos` names it). */
  canWrite(repo: string): boolean;
}

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const UNAVAILABLE = "GitHub tools are not available in this context.";
const MAX_TREE_ENTRIES = 300;
const MAX_ISSUE_BODY_SHOWN = 6000;

function repoOf(input: Record<string, unknown>): string | { error: string } {
  const raw = String(input.repo ?? "")
    .trim()
    .replace(/\.git$/i, "");
  if (!REPO_RE.test(raw))
    return {
      error: `repo must be an owner/name slug (got ${JSON.stringify(raw)}); github_repos lists the repos you can reach.`,
    };
  return raw.toLowerCase();
}

function numberOf(input: Record<string, unknown>): number | { error: string } {
  const n = Number(input.number);
  if (!Number.isInteger(n) || n <= 0)
    return { error: `number must be a positive integer issue number (got ${JSON.stringify(input.number)}).` };
  return n;
}

function strList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const arr = Array.isArray(v) ? v : String(v).split(",");
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

/** One line per error: the API's own words, with 404 read as the two things it usually means. */
function describeError(tool: string, err: unknown, repo?: string): string {
  if (err instanceof GithubApiError) {
    if (err.status === 404)
      return `${tool}: not found${repo ? ` in ${repo}` : ""} — the repo is outside the Switchboard GitHub App installation (github_repos lists the reachable ones), or the path/ref/number does not exist. (${err.message})`;
    if (err.status === 401) return `${tool}: ${err.message}`;
    if (err.status === 403)
      return `${tool}: GitHub refused (HTTP 403) — the App lacks the permission, or a rate limit hit. (${err.message})`;
    return `${tool}: ${err.message}`;
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
    return `${tool}: GitHub timed out.`;
  return `${tool} failed: ${err instanceof Error ? err.message : String(err)}`;
}

function issueLine(i: IssueSummary): string {
  const tags = [
    i.labels.length ? `labels: ${i.labels.join(", ")}` : "",
    i.assignees.length ? `assignees: ${i.assignees.join(", ")}` : "",
  ].filter(Boolean);
  return `#${i.number} [${i.state}] ${i.title} — ${i.author}, updated ${i.updatedAt}${tags.length ? ` (${tags.join("; ")})` : ""}\n   ${i.url}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text;
}

// ---- reads ---------------------------------------------------------------------------

export const githubReposTool: RunnableTool = {
  sideEffectFree: true,
  name: "github_repos",
  description:
    'List the GitHub repositories Switchboard can reach (the org repos in its GitHub App installation), with default branch and description. Use it to resolve a repo the user named loosely ("the web app" → acme/web).',
  inputSchema: { type: "object", properties: {} },
  async run(_input, ctx) {
    if (!ctx.github) return UNAVAILABLE;
    try {
      const repos = await ctx.github.api.listRepos();
      if (repos.length === 0) return "github_repos: the installation covers no repositories.";
      return `Repositories reachable (${repos.length}):\n${repos.map((r) => `- ${r.fullName}${r.private ? " (private)" : ""} — default branch ${r.defaultBranch}${r.description ? ` — ${r.description}` : ""}`).join("\n")}`;
    } catch (err) {
      return describeError("github_repos", err);
    }
  },
};

export const githubFileTool: RunnableTool = {
  sideEffectFree: true,
  name: "github_file",
  description:
    "Read one file from a GitHub repository Switchboard can reach, at a branch/tag/sha (default: the default branch). Returns the text with the blob URL to cite. For GitHub URLs to files, use this instead of web_fetch (private repos need the App credential).",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      path: { type: "string", description: "Path within the repo, e.g. docs/reference/specs/resident-repos.md" },
      ref: { type: "string", description: "Branch, tag, or commit sha (optional)" },
    },
    required: ["repo", "path"],
  },
  async run(input, ctx) {
    if (!ctx.github) return UNAVAILABLE;
    const repo = repoOf(input);
    if (typeof repo !== "string") return `github_file: ${repo.error}`;
    const path = String(input.path ?? "").trim();
    if (!path) return "github_file: path is required.";
    const ref = input.ref ? String(input.ref).trim() : undefined;
    try {
      const f = await ctx.github.api.readFile(repo, path, ref);
      return `${f.url || `${repo}:${f.path}`} (${f.size} bytes${f.truncated ? ", truncated — the file is longer than what is shown" : ""}):\n\n${f.content}`;
    } catch (err) {
      return describeError("github_file", err, repo);
    }
  },
};

export const githubTreeTool: RunnableTool = {
  sideEffectFree: true,
  name: "github_tree",
  description:
    "List a directory of a GitHub repository Switchboard can reach (default: the repo root at the default branch). Use it to find the file to read with github_file.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      path: { type: "string", description: "Directory path (optional; default root)" },
      ref: { type: "string", description: "Branch, tag, or commit sha (optional)" },
    },
    required: ["repo"],
  },
  async run(input, ctx) {
    if (!ctx.github) return UNAVAILABLE;
    const repo = repoOf(input);
    if (typeof repo !== "string") return `github_tree: ${repo.error}`;
    const path = input.path ? String(input.path).trim() : "";
    const ref = input.ref ? String(input.ref).trim() : undefined;
    try {
      const entries = await ctx.github.api.listTree(repo, path, ref);
      const shown = entries.slice(0, MAX_TREE_ENTRIES);
      const lines = shown.map((e) =>
        e.type === "dir"
          ? `${e.path}/`
          : `${e.path}${e.size !== undefined ? ` (${e.size} B)` : ""}${e.type !== "file" ? ` [${e.type}]` : ""}`,
      );
      return `${repo}${ref ? `@${ref}` : ""}:${path || "/"} — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${entries.length > shown.length ? ` (first ${shown.length} shown)` : ""}:\n${lines.join("\n")}`;
    } catch (err) {
      return describeError("github_tree", err, repo);
    }
  },
};

export const githubSearchCodeTool: RunnableTool = {
  sideEffectFree: true,
  name: "github_search_code",
  description:
    "Search code across the repositories Switchboard can reach (GitHub code search; default branches only). Returns matching files with fragments. Optionally limit to one repo.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "GitHub code-search query, e.g. `resident watchdog` or `path:features onboard`",
      },
      repo: { type: "string", description: "owner/name to search within (optional)" },
      limit: { type: "number", description: "Max results, 1-30 (default 10)" },
    },
    required: ["query"],
  },
  async run(input, ctx) {
    if (!ctx.github) return UNAVAILABLE;
    const query = String(input.query ?? "").trim();
    if (!query) return "github_search_code: empty query.";
    let repo: string | undefined;
    if (input.repo) {
      const r = repoOf(input);
      if (typeof r !== "string") return `github_search_code: ${r.error}`;
      repo = r;
    }
    const limit = input.limit != null ? Number(input.limit) : undefined;
    try {
      const hits = await ctx.github.api.searchCode(query, repo, Number.isFinite(limit) ? limit : undefined);
      if (hits.length === 0) return `No code matches for "${query}"${repo ? ` in ${repo}` : ""}.`;
      return `Code matches for "${query}"${repo ? ` in ${repo}` : ""} (${hits.length}):\n\n${hits.map((h, i) => `${i + 1}. ${h.repo}:${h.path}\n   ${h.url}${h.fragments.length ? `\n   ${clip(h.fragments[0].replace(/\s+/g, " ").trim(), 240)}` : ""}`).join("\n\n")}`;
    } catch (err) {
      return describeError("github_search_code", err, repo);
    }
  },
};

export const githubIssueListTool: RunnableTool = {
  sideEffectFree: true,
  name: "github_issue_list",
  description:
    "List issues of a GitHub repository Switchboard can reach (never pull requests), newest-updated first. Filter by state and labels.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      state: { type: "string", enum: ["open", "closed", "all"], description: "Default open" },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Only issues carrying ALL of these labels (optional)",
      },
      limit: { type: "number", description: "Max issues, 1-100 (default 20)" },
    },
    required: ["repo"],
  },
  async run(input, ctx) {
    if (!ctx.github) return UNAVAILABLE;
    const repo = repoOf(input);
    if (typeof repo !== "string") return `github_issue_list: ${repo.error}`;
    const state = input.state === "closed" || input.state === "all" ? input.state : "open";
    const limit = input.limit != null ? Number(input.limit) : undefined;
    try {
      const issues = await ctx.github.api.listIssues(repo, {
        state,
        labels: strList(input.labels),
        ...(Number.isFinite(limit) ? { limit } : {}),
      });
      if (issues.length === 0)
        return `No ${state === "all" ? "" : `${state} `}issues in ${repo}${input.labels ? ` with labels ${strList(input.labels)?.join(", ")}` : ""}.`;
      return `${state === "all" ? "Issues" : `${state[0].toUpperCase()}${state.slice(1)} issues`} in ${repo} (${issues.length}):\n${issues.map(issueLine).join("\n")}`;
    } catch (err) {
      return describeError("github_issue_list", err, repo);
    }
  },
};

export const githubIssueGetTool: RunnableTool = {
  sideEffectFree: true,
  name: "github_issue_get",
  description:
    "Read one issue of a GitHub repository Switchboard can reach: title, state, labels, assignees, body, and its comments.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      number: { type: "number", description: "Issue number" },
    },
    required: ["repo", "number"],
  },
  async run(input, ctx) {
    if (!ctx.github) return UNAVAILABLE;
    const repo = repoOf(input);
    if (typeof repo !== "string") return `github_issue_get: ${repo.error}`;
    const number = numberOf(input);
    if (typeof number !== "number") return `github_issue_get: ${number.error}`;
    try {
      const { issue, comments } = await ctx.github.api.getIssue(repo, number);
      const head = `${repo}#${issue.number} [${issue.state}] ${issue.title}\n${issue.url}\nby ${issue.author}, created ${issue.createdAt}, updated ${issue.updatedAt}${issue.labels.length ? `\nlabels: ${issue.labels.join(", ")}` : ""}${issue.assignees.length ? `\nassignees: ${issue.assignees.join(", ")}` : ""}`;
      const body = `\n\n${clip(issue.body?.trim() || "(no body)", MAX_ISSUE_BODY_SHOWN)}`;
      const thread = comments.length
        ? `\n\n--- ${comments.length} comment${comments.length === 1 ? "" : "s"} ---\n${comments.map((c) => `[${c.author}, ${c.createdAt}]\n${clip(c.body.trim(), 2000)}`).join("\n\n")}`
        : "";
      return head + body + thread;
    } catch (err) {
      return describeError("github_issue_get", err, repo);
    }
  },
};

// ---- writes (gated) ------------------------------------------------------------------

function writeGate(tool: string, ctx: Parameters<RunnableTool["run"]>[1], repo: string): string | undefined {
  if (!ctx.github) return UNAVAILABLE;
  if (!ctx.github.canWrite(repo))
    return `${tool}: you are not allowed to write to ${repo} (it is restricted and you hold no grant for it) — say so to the user instead of retrying.`;
  return undefined;
}

export const githubIssueCreateTool: RunnableTool = {
  name: "github_issue_create",
  description:
    "Open a new issue in a GitHub repository Switchboard can reach. Confirm the repo if the user named it loosely (github_repos). Returns the issue number and URL — quote them in your answer.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      title: { type: "string", description: "Issue title" },
      body: { type: "string", description: "Issue body (GitHub markdown; optional)" },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Labels to apply (optional; must exist in the repo)",
      },
      assignees: { type: "array", items: { type: "string" }, description: "GitHub logins to assign (optional)" },
    },
    required: ["repo", "title"],
  },
  async run(input, ctx) {
    const repo = repoOf(input);
    if (typeof repo !== "string") return `github_issue_create: ${repo.error}`;
    const refused = writeGate("github_issue_create", ctx, repo);
    if (refused) return refused;
    const title = String(input.title ?? "").trim();
    if (!title) return "github_issue_create: title is required.";
    try {
      const issue = await ctx.github!.api.createIssue(repo, {
        title,
        ...(input.body !== undefined ? { body: String(input.body) } : {}),
        labels: strList(input.labels),
        assignees: strList(input.assignees),
      });
      return `Opened ${repo}#${issue.number}: ${issue.title}\n${issue.url}`;
    } catch (err) {
      return describeError("github_issue_create", err, repo);
    }
  },
};

export const githubIssueUpdateTool: RunnableTool = {
  name: "github_issue_update",
  description:
    "Edit an existing issue in a GitHub repository Switchboard can reach: title, body, state (open/closed), labels, assignees. Only the fields given change. Closing an issue is state=closed.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      number: { type: "number", description: "Issue number" },
      title: { type: "string" },
      body: { type: "string", description: "Replaces the whole body" },
      state: { type: "string", enum: ["open", "closed"] },
      labels: { type: "array", items: { type: "string" }, description: "Replaces the label set" },
      assignees: { type: "array", items: { type: "string" }, description: "Replaces the assignee set" },
    },
    required: ["repo", "number"],
  },
  async run(input, ctx) {
    const repo = repoOf(input);
    if (typeof repo !== "string") return `github_issue_update: ${repo.error}`;
    const refused = writeGate("github_issue_update", ctx, repo);
    if (refused) return refused;
    const number = numberOf(input);
    if (typeof number !== "number") return `github_issue_update: ${number.error}`;
    const patch = {
      ...(input.title !== undefined ? { title: String(input.title) } : {}),
      ...(input.body !== undefined ? { body: String(input.body) } : {}),
      ...(input.state === "open" || input.state === "closed" ? { state: input.state as "open" | "closed" } : {}),
      ...(input.labels !== undefined ? { labels: strList(input.labels) ?? [] } : {}),
      ...(input.assignees !== undefined ? { assignees: strList(input.assignees) ?? [] } : {}),
    };
    if (Object.keys(patch).length === 0)
      return "github_issue_update: nothing to change — pass title, body, state, labels, or assignees.";
    try {
      const issue = await ctx.github!.api.updateIssue(repo, number, patch);
      return `Updated ${repo}#${issue.number} (${Object.keys(patch).join(", ")}): [${issue.state}] ${issue.title}\n${issue.url}`;
    } catch (err) {
      return describeError("github_issue_update", err, repo);
    }
  },
};

export const githubIssueCommentTool: RunnableTool = {
  name: "github_issue_comment",
  description: "Add a comment to an issue in a GitHub repository Switchboard can reach.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      number: { type: "number", description: "Issue number" },
      body: { type: "string", description: "Comment text (GitHub markdown)" },
    },
    required: ["repo", "number", "body"],
  },
  async run(input, ctx) {
    const repo = repoOf(input);
    if (typeof repo !== "string") return `github_issue_comment: ${repo.error}`;
    const refused = writeGate("github_issue_comment", ctx, repo);
    if (refused) return refused;
    const number = numberOf(input);
    if (typeof number !== "number") return `github_issue_comment: ${number.error}`;
    const body = String(input.body ?? "").trim();
    if (!body) return "github_issue_comment: body is required.";
    try {
      const { url } = await ctx.github!.api.commentIssue(repo, number, body);
      return `Commented on ${repo}#${number}\n${url}`;
    } catch (err) {
      return describeError("github_issue_comment", err, repo);
    }
  },
};

export const githubIssueDeleteTool: RunnableTool = {
  name: "github_issue_delete",
  description:
    "PERMANENTLY delete an issue in a GitHub repository Switchboard can reach. Irreversible — use only when the user explicitly asked to delete (closing is github_issue_update state=closed). Requires the exact issue number. Note: GitHub grants deletion only to a repo admin's user credential; with the App credential this reports the refusal honestly and nothing changes.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      number: { type: "number", description: "Issue number" },
    },
    required: ["repo", "number"],
  },
  async run(input, ctx) {
    const repo = repoOf(input);
    if (typeof repo !== "string") return `github_issue_delete: ${repo.error}`;
    const refused = writeGate("github_issue_delete", ctx, repo);
    if (refused) return refused;
    const number = numberOf(input);
    if (typeof number !== "number") return `github_issue_delete: ${number.error}`;
    try {
      await ctx.github!.api.deleteIssue(repo, number);
      return `Deleted ${repo}#${number} permanently.`;
    } catch (err) {
      // GitHub allows issue deletion only to a repository admin's USER
      // credential — never to an App installation, which GitHub refuses with a
      // 403 "Viewer not authorized to delete". Say exactly that, and what IS
      // possible.
      if (err instanceof GithubApiError && err.status === 403) {
        return `github_issue_delete: GitHub refused — issue deletion is not available to Switchboard's GitHub App credential (only a repository admin can delete an issue, in the GitHub UI). Nothing was changed. Offer to close it instead (github_issue_update state=closed), or tell the user to delete ${repo}#${number} themselves.`;
      }
      return describeError("github_issue_delete", err, repo);
    }
  },
};

// ---- Actions triage (docs/reference/specs/github-tools.md item 9) ---------------------

const ACTIONS_URL_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?(?:\/job\/(\d+))?(?:[/?#].*)?$/i;
/** The line prefix GitHub puts on every log line: an ISO timestamp with 7 fractional digits. */
const LOG_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_LINES = 2000;
const MAX_ERROR_LINES = 30;
/** Conclusions that read as "this went wrong" — they sort first and get the ✗. */
const BAD = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);
/** The order jobs and their counts are shown in: what went wrong, what is still going, what passed, the rest. */
const OUTCOME_RANK = [
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
  "in_progress",
  "queued",
  "waiting",
  "pending",
  "requested",
  "success",
  "skipped",
  "neutral",
];

/** The repo and the one id the tool reads: a run id for `github_actions_run`, a job id for `github_actions_job_log`. */
type ActionsRef = { repo: string; id: number } | { error: string };

/** `run`/`job` as an id (with `repo`) or a github.com Actions URL (which names the repo itself). */
function actionsRef(
  tool: "github_actions_run" | "github_actions_job_log",
  input: Record<string, unknown>,
  key: "run" | "job",
): ActionsRef {
  const raw = input[key];
  const s = String(raw ?? "").trim();
  const noun = key === "run" ? "run" : "job";
  const shape =
    key === "run"
      ? "github.com/<owner>/<repo>/actions/runs/<id>"
      : "github.com/<owner>/<repo>/actions/runs/<run>/job/<id>";
  const explicit = input.repo !== undefined && String(input.repo).trim() !== "" ? repoOf(input) : undefined;
  if (typeof explicit === "object") return { error: `${tool}: ${explicit.error}` };
  if (/^\d+$/.test(s)) {
    if (!explicit)
      return { error: `${tool}: repo is required when ${noun} is an id (owner/name), or pass the ${noun}'s URL.` };
    return { repo: explicit, id: Number(s) };
  }
  const m = ACTIONS_URL_RE.exec(s);
  if (!m) return { error: `${tool}: ${noun} must be a ${noun} id or a ${shape} URL (got ${JSON.stringify(s)}).` };
  const repo = `${m[1]}/${m[2]}`.toLowerCase();
  if (explicit && explicit !== repo)
    return { error: `${tool}: the URL names ${repo} but repo says ${explicit} — pass one or the other.` };
  if (key === "run") return { repo, id: Number(m[3]) };
  if (!m[4])
    return { error: `${tool}: that URL names a run, not a job — github_actions_run lists its jobs with their ids.` };
  return { repo, id: Number(m[4]) };
}

/** `4m12s`, `2s`, `1h03m` — the span between two ISO instants, or undefined without both. */
function spanOf(from: string | null | undefined, to: string | null | undefined): string | undefined {
  if (!from || !to) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const outcomeOf = (x: { status: string; conclusion: string | null }): string => x.conclusion ?? x.status;
const rankOf = (outcome: string): number => {
  const i = OUTCOME_RANK.indexOf(outcome);
  return i < 0 ? OUTCOME_RANK.length : i;
};
const markOf = (outcome: string): string => (BAD.has(outcome) ? "✗" : outcome === "success" ? "✓" : "·");
const quote = (s: string): string => `“${s}”`;

function stepsLine(job: ActionsJob): string {
  if (job.steps.length === 0) return "Steps: none reported yet";
  return `Steps: ${job.steps
    .map((s) => {
      const outcome = outcomeOf(s);
      const mark = BAD.has(outcome) ? "✗" : outcome === "success" ? "✓" : "–";
      // A finished step shows how long it took; a skipped or still-running one shows that instead.
      const tail = outcome === "success" || BAD.has(outcome) ? spanOf(s.startedAt, s.completedAt) : outcome;
      return `${mark} ${s.number} ${s.name}${tail ? ` (${tail})` : ""}`;
    })
    .join(" · ")}`;
}

export const githubActionsRunTool: RunnableTool = {
  sideEffectFree: true,
  name: "github_actions_run",
  description:
    'Read one GitHub Actions workflow run: its status and conclusion, the branch, sha and event, and every job with its conclusion, duration and failed steps. Pass the run URL a person pasted (github.com/<owner>/<repo>/actions/runs/<id>, a /job/<id> URL works too) or repo + run id. Start here for "why did this run fail?", then read the failed job with github_actions_job_log.',
  inputSchema: {
    type: "object",
    properties: {
      run: { type: "string", description: "The run's github.com URL, or its numeric id (then repo is required)" },
      repo: { type: "string", description: "owner/name — only when run is an id" },
    },
    required: ["run"],
  },
  async run(input, ctx) {
    if (!ctx.github) return UNAVAILABLE;
    const ref = actionsRef("github_actions_run", input, "run");
    if ("error" in ref) return ref.error;
    try {
      const { run, jobs } = await ctx.github.api.getActionsRun(ref.repo, ref.id);
      const sorted = [...jobs].sort(
        (a, b) => rankOf(outcomeOf(a)) - rankOf(outcomeOf(b)) || a.name.localeCompare(b.name),
      );
      const counts = new Map<string, number>();
      for (const j of sorted) counts.set(outcomeOf(j), (counts.get(outcomeOf(j)) ?? 0) + 1);
      const attempt = run.runAttempt > 1 ? ` (attempt ${run.runAttempt})` : "";
      const verdict = run.conclusion ? `${run.conclusion} (${run.status})` : run.status;
      const title = run.displayTitle ? ` · ${quote(run.displayTitle)}` : "";
      const lines = [
        `${ref.repo} · ${run.name} run #${run.runNumber}${attempt} — ${verdict} · ${run.event} on ${run.headBranch} @ ${run.headSha.slice(0, 7)}${title}`,
        `${run.url} · started ${run.runStartedAt}, ${spanOf(run.runStartedAt, run.updatedAt) ?? "?"} to the last update · ${run.workflowPath}`,
        "",
        `Jobs (${jobs.length}): ${[...counts.entries()].map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`,
      ];
      for (const j of sorted) {
        const outcome = outcomeOf(j);
        const took = spanOf(j.startedAt, j.completedAt);
        lines.push(`${markOf(outcome)} ${j.name} — ${outcome}${took ? `, ${took}` : ""} (job ${j.id})`);
        if (outcome === "success") continue;
        const notable = j.steps.filter((s) => outcomeOf(s) !== "success");
        if (notable.length)
          lines.push(
            `   ${notable
              .map((s) => {
                const o = outcomeOf(s);
                const took = BAD.has(o) ? spanOf(s.startedAt, s.completedAt) : undefined;
                return `${o === "failure" ? "failed" : o} step ${s.number} ${quote(s.name)}${took ? ` (${took})` : ""}`;
              })
              .join("; ")}`,
          );
        if (j.url) lines.push(`   ${j.url}`);
      }
      const failed = sorted.filter((j) => BAD.has(outcomeOf(j)));
      lines.push("");
      if (failed.length) {
        const [first, ...rest] = failed;
        const others = rest.length ? ` (or ${rest.map((j) => j.id).join(", ")})` : "";
        lines.push(
          `Next: github_actions_job_log with job ${first.id}${others} shows the failed job's errors and the end of its log.`,
        );
      } else if (run.status !== "completed") lines.push("The run is still running; ask again for its final state.");
      else lines.push("Every job succeeded.");
      return lines.join("\n");
    } catch (err) {
      return describeError("github_actions_run", err, ref.repo);
    }
  },
};

export const githubActionsJobLogTool: RunnableTool = {
  sideEffectFree: true,
  name: "github_actions_job_log",
  description:
    "Read one GitHub Actions job's log: its steps with their conclusions, every ##[error] line, and the last `lines` lines of the log (default 200, max 2000) — or, with `match`, only the lines containing that text. Pass the job URL (github.com/<owner>/<repo>/actions/runs/<run>/job/<id>) or repo + job id; github_actions_run lists a run's jobs with their ids. Timestamps are stripped.",
  inputSchema: {
    type: "object",
    properties: {
      job: { type: "string", description: "The job's github.com URL, or its numeric id (then repo is required)" },
      repo: { type: "string", description: "owner/name — only when job is an id" },
      lines: { type: "integer", description: "How many lines of the log's end to show (default 200, max 2000)" },
      match: {
        type: "string",
        description: "Show only lines containing this text (case-insensitive) instead of the tail",
      },
    },
    required: ["job"],
  },
  async run(input, ctx) {
    if (!ctx.github) return UNAVAILABLE;
    const ref = actionsRef("github_actions_job_log", input, "job");
    if ("error" in ref) return ref.error;
    const want = Math.min(MAX_TAIL_LINES, Math.max(1, Math.trunc(Number(input.lines)) || DEFAULT_TAIL_LINES));
    const match = input.match === undefined || input.match === null ? "" : String(input.match).trim();
    try {
      const [job, log] = await Promise.all([
        ctx.github.api.getActionsJob(ref.repo, ref.id),
        ctx.github.api.getActionsJobLog(ref.repo, ref.id),
      ]);
      const outcome = outcomeOf(job);
      const took = spanOf(job.startedAt, job.completedAt);
      const out = [
        `${ref.repo} · job ${quote(job.name)} (${job.id}) of run ${job.runId} — ${outcome}${took ? `, ${took}` : ""} · runner ${job.runnerName ?? "unknown"}`,
        job.url,
        stepsLine(job),
      ];
      if (job.status !== "completed") out.push("The job is still running; the log is what GitHub has so far.");
      if (!log.complete) out.push(`The log ran past ${ACTIONS_LOG_MAX_CHARS} characters; only its end is shown.`);
      // Remote text: redact before anything else reads it (resident-repos item 62's rule), then drop
      // the per-line timestamp so a line costs its words, not its clock.
      const all = redactSecrets(stripAnsi(log.text))
        .split("\n")
        .map((l) => l.replace(LOG_TIMESTAMP_RE, ""));
      if (all.length && all[all.length - 1] === "") all.pop();
      const errors = all.filter((l) => l.includes("##[error]"));
      out.push("");
      if (errors.length === 0) out.push("Errors: no ##[error] lines.");
      else {
        out.push(`Errors (${errors.length}):`, ...errors.slice(0, MAX_ERROR_LINES));
        if (errors.length > MAX_ERROR_LINES) out.push(`… (${errors.length - MAX_ERROR_LINES} more)`);
      }
      out.push("");
      if (match) {
        const needle = match.toLowerCase();
        const hits = all.filter((l) => l.toLowerCase().includes(needle));
        if (hits.length === 0) out.push(`Lines matching ${JSON.stringify(match)} (0 of ${all.length}): none.`);
        else {
          out.push(
            `Lines matching ${JSON.stringify(match)} (${hits.length} of ${all.length}):`,
            ...hits.slice(0, want),
          );
          if (hits.length > want) out.push(`… (${hits.length - want} more; raise lines or narrow match)`);
        }
      } else {
        const tail = all.slice(-want);
        out.push(`Last ${tail.length} lines of ${all.length}:`, ...tail);
      }
      return out.join("\n");
    } catch (err) {
      return describeError("github_actions_job_log", err, ref.repo);
    }
  },
};

/** Repository + issue READS — safe for every agent with a tool loop. */
export const GITHUB_READ_TOOLS: RunnableTool[] = [
  githubReposTool,
  githubFileTool,
  githubTreeTool,
  githubSearchCodeTool,
  githubIssueListTool,
  githubIssueGetTool,
  githubActionsRunTool,
  githubActionsJobLogTool,
];
/** Issue WRITES — gated per repo by the requesting user's permission. */
export const GITHUB_ISSUE_WRITE_TOOLS: RunnableTool[] = [
  githubIssueCreateTool,
  githubIssueUpdateTool,
  githubIssueCommentTool,
  githubIssueDeleteTool,
];
