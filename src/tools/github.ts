import { GithubApiError, type GithubApi, type IssueSummary } from "../execution/githubApi.js";
import type { RunnableTool } from "./workspace.js";

// The `github_*` tools (features/github-tools.md): every agent with a tool
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
    'List the GitHub repositories Switchboard can reach (the org repos in its GitHub App installation), with default branch and description. Use it to resolve a repo the user named loosely ("the switchboard app" → coreplanelabs/switchboard).',
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
      path: { type: "string", description: "Path within the repo, e.g. features/resident-repos.md" },
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
      // credential — never to an App installation (live 2026-09-03: "Viewer
      // not authorized to delete"). Say exactly that, and what IS possible.
      if (err instanceof GithubApiError && err.status === 403) {
        return `github_issue_delete: GitHub refused — issue deletion is not available to Switchboard's GitHub App credential (only a repository admin can delete an issue, in the GitHub UI). Nothing was changed. Offer to close it instead (github_issue_update state=closed), or tell the user to delete ${repo}#${number} themselves.`;
      }
      return describeError("github_issue_delete", err, repo);
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
];
/** Issue WRITES — gated per repo by the requesting user's permission. */
export const GITHUB_ISSUE_WRITE_TOOLS: RunnableTool[] = [
  githubIssueCreateTool,
  githubIssueUpdateTool,
  githubIssueCommentTool,
  githubIssueDeleteTool,
];
