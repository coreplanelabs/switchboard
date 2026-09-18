import { tracedFetch } from "../core/trace/tracedFetch.js";
import type { Span } from "../core/trace/types.js";
import { resolveGithubToken, type GithubTokenScope } from "./githubApp.js";
import { classifyError } from "../core/trace/classify.js";
import { redactAndCap } from "../core/redact.js";
import { MINUTE_MS } from "../core/budgets.js";

// The GitHub capability behind the `github_*` agent tools
// (docs/reference/specs/github-tools.md): repository reads (files, trees, code search, the
// installation's repo list) and issue reads/writes over the GitHub REST API
// from the bot process, authenticated with the App's installation token —
// never a `gh` shell-out, never a clone (AGENTS.md invariant 5). `GithubApi`
// is the seam; `RestGithubApi` is production and `InMemoryGithubApi` the second
// implementation (invariant 2) and the test double. Reads mint the READ-scoped
// token, writes the write-scoped one, so a read tool can never write even if a
// prompt-injected page asks it to.

const REQUEST_TIMEOUT_MS = 15_000;
/** `listIssues` reads at most this many 100-row pages while filling `limit`. */
const MAX_ISSUE_PAGES = 3;
/** `getActionsRun` reads at most this many 100-row job pages. */
const MAX_JOB_PAGES = 3;
/** A job log is read to its end (a tail window), so it gets a longer deadline than a JSON call. */
const LOG_TIMEOUT_MS = MINUTE_MS;
/** GitHub rejects an issue body over 65536 chars; clip with a visible note. */
const MAX_BODY_CHARS = 65_000;
/** A file the model can usefully read in one call; larger files are clipped
 *  with a note (the tool says how to read a range). */
export const MAX_FILE_CHARS = 200_000;

/** How much of a file `readFile` hands back: `maxChars` characters, the tool
 *  clip when unset. The bound is the caller's business — the model's tool
 *  keeps the clip, a plan reader needs the whole document. */
export interface ReadFileOptions {
  maxChars?: number;
}

export interface RepoFile {
  path: string;
  /** Decoded UTF-8 text (binary files come back as a note, not bytes). */
  content: string;
  size: number;
  truncated: boolean;
  sha: string;
  /** The blob URL at the ref that was read (for citing). */
  url: string;
}

export interface TreeEntry {
  path: string;
  type: "file" | "dir" | "submodule" | "symlink";
  size?: number;
}

export interface CodeSearchHit {
  repo: string;
  path: string;
  url: string;
  /** Matching text fragments GitHub returned (may be empty). */
  fragments: string[];
}

export interface InstallationRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
}

export interface IssueSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  labels: string[];
  assignees: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  /** Present on `getIssue` (and on list rows when GitHub returns it). */
  body?: string;
  comments?: number;
}

export interface IssueComment {
  author: string;
  createdAt: string;
  body: string;
}

export interface NewIssueInput {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

export interface IssuePatch {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
}

export interface GithubApi {
  /** A view of this client whose calls are `github.rest` children of `span`
   *  (docs/reference/specs/tracing.md item 23) — the runner binds one per tool call. A
   *  client without it (a test double) is used as is. */
  withSpan?(span: Span): GithubApi;
  listRepos(): Promise<InstallationRepo[]>;
  /** A file's text at a ref, clipped at `opts.maxChars` (the tool clip
   *  `MAX_FILE_CHARS` when absent) with `truncated` saying so; a reader that
   *  needs the whole document, a plan the runner parses units out of, passes
   *  its own bound and refuses a `truncated` answer by name. */
  readFile(repo: string, path: string, ref?: string, opts?: ReadFileOptions): Promise<RepoFile>;
  listTree(repo: string, path?: string, ref?: string): Promise<TreeEntry[]>;
  searchCode(query: string, repo?: string, limit?: number): Promise<CodeSearchHit[]>;
  listIssues(
    repo: string,
    opts?: { state?: "open" | "closed" | "all"; labels?: string[]; limit?: number },
  ): Promise<IssueSummary[]>;
  getIssue(repo: string, number: number): Promise<{ issue: IssueSummary; comments: IssueComment[] }>;
  createIssue(repo: string, input: NewIssueInput): Promise<IssueSummary>;
  updateIssue(repo: string, number: number, patch: IssuePatch): Promise<IssueSummary>;
  commentIssue(repo: string, number: number, body: string): Promise<{ url: string }>;
  /** Permanent. GitHub exposes this only over GraphQL (`deleteIssue`). */
  deleteIssue(repo: string, number: number): Promise<void>;
  /** The unified diff of `base...head` as GitHub renders it (`Accept:
   *  application/vnd.github.diff`) — the abridged reading diff's complete
   *  input (docs/reference/specs/reading-diff.md item 6). Read up to `maxChars`
   *  (default `COMPARE_DIFF_MAX_CHARS`) and no further: `complete: false`
   *  says the diff went on past the cap. GitHub itself answers 406 for a
   *  comparison too large to render as a diff (a `GithubApiError`). */
  compareDiff(repo: string, base: string, head: string, maxChars?: number): Promise<CompareDiff>;
  /** A workflow run and its jobs with their steps (item 9) — `actions: read` on the read token. */
  getActionsRun(repo: string, runId: number): Promise<{ run: ActionsRun; jobs: ActionsJob[] }>;
  getActionsJob(repo: string, jobId: number): Promise<ActionsJob>;
  /** One job's log, its last `maxChars` characters (default `ACTIONS_LOG_MAX_CHARS`);
   *  the 302 to the signed blob URL is followed without the App credential. */
  getActionsJobLog(repo: string, jobId: number, maxChars?: number): Promise<ActionsJobLog>;
}

export interface CompareDiff {
  diff: string;
  /** False when the diff was longer than the cap and was cut there. */
  complete: boolean;
}

/** The most of a compare diff the bot reads: about ten times the recorded
 *  artifact's cap — beyond it no model abridges the change usefully anyway. */
export const COMPARE_DIFF_MAX_CHARS = 1_200_000;

/** One workflow run as the triage tools show it (docs/reference/specs/github-tools.md item 9). */
export interface ActionsRun {
  id: number;
  /** The workflow's name (`CI`). */
  name: string;
  /** The run's title: the commit subject or the PR title. */
  displayTitle: string;
  /** The workflow file (`.github/workflows/ci.yml`). */
  workflowPath: string;
  /** `queued` | `in_progress` | `completed` | … as GitHub words it. */
  status: string;
  /** `success` | `failure` | `cancelled` | … ; null while the run is live. */
  conclusion: string | null;
  event: string;
  headBranch: string;
  headSha: string;
  runNumber: number;
  runAttempt: number;
  url: string;
  createdAt: string;
  runStartedAt: string;
  updatedAt: string;
}

export interface ActionsStep {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ActionsJob {
  id: number;
  runId: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  startedAt: string | null;
  completedAt: string | null;
  runnerName: string | null;
  steps: ActionsStep[];
}

export interface ActionsJobLog {
  /** The log's text — its LAST `maxChars` characters when it ran past the cap. */
  text: string;
  /** False when the log was longer than the cap and its head was dropped. */
  complete: boolean;
}

/** The most of a job log the bot keeps: its tail, where a failed job's failure
 *  is — a multi-MB log costs this much memory and no more. */
export const ACTIONS_LOG_MAX_CHARS = 2_000_000;

/** Thrown for every non-success GitHub answer; `status` lets a tool word 404s
 *  ("outside the installation, or no such path") apart from the rest. */
export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

export interface RestGithubApiOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Credential resolver per scope; defaults to the App installation token
   *  (read-scoped for reads, write-scoped for writes), else GH_TOKEN. The
   *  caller's span, when it has one, so a mint is a `github.token_mint` child. */
  token?: (scope: GithubTokenScope, span?: Span) => Promise<string | null>;
}

/** The closed table of routes a `github.rest` span names — never the path,
 *  which carries a repo, a file path or a query. */
export type GithubRoute =
  | "installation_repos"
  | "contents"
  | "contents_raw"
  | "search_code"
  | "issues"
  | "issue"
  | "issue_comments"
  | "issue_create"
  | "issue_update"
  | "issue_comment_create"
  | "compare"
  | "actions_run"
  | "actions_run_jobs"
  | "actions_job"
  | "actions_job_logs"
  | "actions_job_logs_blob"
  | "graphql"
  | "app_installation_token";

const clipBody = (body: string | undefined): string | undefined =>
  body !== undefined && body.length > MAX_BODY_CHARS
    ? `${body.slice(0, MAX_BODY_CHARS)}\n\n_(clipped by Switchboard: body exceeded ${MAX_BODY_CHARS} chars)_`
    : body;

export class RestGithubApi implements GithubApi {
  private readonly fetchImpl: typeof fetch;
  private readonly token: (scope: GithubTokenScope, span?: Span) => Promise<string | null>;
  /** The span this view's calls hang under; the shared client has none. */
  private parent: Span | undefined;

  constructor(opts: RestGithubApiOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.token = opts.token ?? ((scope, span) => resolveGithubToken(scope, span));
  }

  withSpan(span: Span): RestGithubApi {
    // The same fetch and the same token resolver (its cache is module-wide),
    // one span: a view, not a second client.
    const view = new RestGithubApi({ fetch: this.fetchImpl, token: this.token });
    view.parent = span;
    return view;
  }

  async listRepos(): Promise<InstallationRepo[]> {
    const out: InstallationRepo[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await this.request(
        "read",
        "GET",
        "installation_repos",
        `/installation/repositories?per_page=100&page=${page}`,
      );
      const body = (await res.json()) as { repositories?: Array<Record<string, unknown>>; total_count?: number };
      for (const r of body.repositories ?? []) {
        out.push({
          fullName: String(r.full_name),
          private: Boolean(r.private),
          defaultBranch: String(r.default_branch ?? "main"),
          description: typeof r.description === "string" ? r.description : null,
        });
      }
      if ((body.repositories ?? []).length < 100) break;
    }
    return out;
  }

  async readFile(repo: string, path: string, ref?: string, opts?: ReadFileOptions): Promise<RepoFile> {
    const maxChars = opts?.maxChars ?? MAX_FILE_CHARS;
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const res = await this.request("read", "GET", "contents", `/repos/${repo}/contents/${encodePath(path)}${q}`);
    const body = (await res.json()) as Record<string, unknown>;
    if (Array.isArray(body)) throw new GithubApiError(400, `${path} is a directory — list it with github_tree`);
    if (body.type !== "file") throw new GithubApiError(400, `${path} is a ${String(body.type)}, not a file`);
    const size = Number(body.size ?? 0);
    const encoding = String(body.encoding ?? "");
    let content: string;
    if (encoding === "base64")
      content = Buffer.from(String(body.content ?? "").replace(/\n/g, ""), "base64").toString("utf8");
    else if (encoding === "none") {
      // Over ~1 MB GitHub omits the content; read the blob via the raw media
      // type, streaming only as far as the clip — never the whole file.
      const raw = await this.request(
        "read",
        "GET",
        "contents_raw",
        `/repos/${repo}/contents/${encodePath(path)}${q}`,
        undefined,
        "application/vnd.github.raw+json",
      );
      content = await readTextCapped(raw, maxChars + 1);
    } else content = String(body.content ?? "");
    if (content.includes("\u0000")) content = `(binary file, ${size} bytes — not shown)`;
    const truncated = content.length > maxChars;
    return {
      path,
      content: truncated ? content.slice(0, maxChars) : content,
      size,
      truncated,
      sha: String(body.sha ?? ""),
      url: String(body.html_url ?? ""),
    };
  }

  async listTree(repo: string, path = "", ref?: string): Promise<TreeEntry[]> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const res = await this.request("read", "GET", "contents", `/repos/${repo}/contents/${encodePath(path)}${q}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new GithubApiError(400, `${path || "/"} is a file — read it with github_file`);
    return (body as Array<Record<string, unknown>>).map((e) => ({
      path: String(e.path),
      type: (e.type === "dir" || e.type === "submodule" || e.type === "symlink" ? e.type : "file") as TreeEntry["type"],
      ...(typeof e.size === "number" && e.type === "file" ? { size: e.size } : {}),
    }));
  }

  async searchCode(query: string, repo?: string, limit = 10): Promise<CodeSearchHit[]> {
    const q = repo ? `${query} repo:${repo}` : query;
    const res = await this.request(
      "read",
      "GET",
      "search_code",
      `/search/code?q=${encodeURIComponent(q)}&per_page=${Math.min(Math.max(limit, 1), 30)}`,
      undefined,
      "application/vnd.github.text-match+json",
    );
    const body = (await res.json()) as { items?: Array<Record<string, unknown>> };
    return (body.items ?? []).map((it) => ({
      repo: String((it.repository as Record<string, unknown> | undefined)?.full_name ?? ""),
      path: String(it.path),
      url: String(it.html_url ?? ""),
      fragments: Array.isArray(it.text_matches)
        ? (it.text_matches as Array<Record<string, unknown>>).map((m) => String(m.fragment ?? "")).filter(Boolean)
        : [],
    }));
  }

  async listIssues(
    repo: string,
    opts: { state?: "open" | "closed" | "all"; labels?: string[]; limit?: number } = {},
  ): Promise<IssueSummary[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    // GitHub's issues endpoint interleaves pull requests, which are dropped
    // here — so a page of `limit` rows can hold fewer than `limit` issues.
    // Read full pages until `limit` issues are in hand or the list ends
    // (bounded, so a PR-only repo cannot page forever).
    const out: IssueSummary[] = [];
    for (let page = 1; page <= MAX_ISSUE_PAGES && out.length < limit; page++) {
      const params = new URLSearchParams({
        state: opts.state ?? "open",
        per_page: "100",
        page: String(page),
        sort: "updated",
        direction: "desc",
      });
      if (opts.labels?.length) params.set("labels", opts.labels.join(","));
      const res = await this.request("read", "GET", "issues", `/repos/${repo}/issues?${params.toString()}`);
      const rows = (await res.json()) as Array<Record<string, unknown>>;
      for (const r of rows) if (!("pull_request" in r)) out.push(toIssue(r));
      if (rows.length < 100) break;
    }
    return out.slice(0, limit);
  }

  async getIssue(repo: string, number: number): Promise<{ issue: IssueSummary; comments: IssueComment[] }> {
    const res = await this.request("read", "GET", "issue", `/repos/${repo}/issues/${number}`);
    const row = (await res.json()) as Record<string, unknown>;
    if ("pull_request" in row) throw new GithubApiError(400, `#${number} is a pull request, not an issue`);
    const issue = toIssue(row);
    let comments: IssueComment[] = [];
    if ((issue.comments ?? 0) > 0) {
      const c = await this.request(
        "read",
        "GET",
        "issue_comments",
        `/repos/${repo}/issues/${number}/comments?per_page=30`,
      );
      comments = ((await c.json()) as Array<Record<string, unknown>>).map((x) => ({
        author: String((x.user as Record<string, unknown> | undefined)?.login ?? "?"),
        createdAt: String(x.created_at ?? ""),
        body: String(x.body ?? ""),
      }));
    }
    return { issue, comments };
  }

  async compareDiff(repo: string, base: string, head: string, maxChars = COMPARE_DIFF_MAX_CHARS): Promise<CompareDiff> {
    const res = await this.request(
      "read",
      "GET",
      "compare",
      `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      undefined,
      "application/vnd.github.diff",
    );
    // One char past the cap tells "cut here" from "exactly this long".
    const text = await readTextCapped(res, maxChars + 1);
    return text.length > maxChars ? { diff: text.slice(0, maxChars), complete: false } : { diff: text, complete: true };
  }

  async createIssue(repo: string, input: NewIssueInput): Promise<IssueSummary> {
    const res = await this.request("write", "POST", "issue_create", `/repos/${repo}/issues`, {
      title: input.title,
      ...(input.body !== undefined ? { body: clipBody(input.body) } : {}),
      ...(input.labels?.length ? { labels: input.labels } : {}),
      ...(input.assignees?.length ? { assignees: input.assignees } : {}),
    });
    return toIssue((await res.json()) as Record<string, unknown>);
  }

  async updateIssue(repo: string, number: number, patch: IssuePatch): Promise<IssueSummary> {
    const res = await this.request("write", "PATCH", "issue_update", `/repos/${repo}/issues/${number}`, {
      ...patch,
      ...(patch.body !== undefined ? { body: clipBody(patch.body) } : {}),
    });
    return toIssue((await res.json()) as Record<string, unknown>);
  }

  async commentIssue(repo: string, number: number, body: string): Promise<{ url: string }> {
    const res = await this.request(
      "write",
      "POST",
      "issue_comment_create",
      `/repos/${repo}/issues/${number}/comments`,
      {
        body: clipBody(body),
      },
    );
    const row = (await res.json()) as Record<string, unknown>;
    return { url: String(row.html_url ?? "") };
  }

  async deleteIssue(repo: string, number: number): Promise<void> {
    const res = await this.request("read", "GET", "issue", `/repos/${repo}/issues/${number}`);
    const row = (await res.json()) as Record<string, unknown>;
    if ("pull_request" in row) throw new GithubApiError(400, `#${number} is a pull request, not an issue`);
    const nodeId = String(row.node_id ?? "");
    if (!nodeId) throw new GithubApiError(500, `GitHub returned no node id for ${repo}#${number}`);
    const gql = await this.request("write", "POST", "graphql", "/graphql", {
      query: "mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }",
      variables: { id: nodeId },
    });
    const body = (await gql.json()) as { errors?: Array<{ message?: string; type?: string }> };
    if (body.errors?.length) {
      const msg = body.errors.map((e) => e.message ?? e.type ?? "error").join("; ");
      // An App installation gets "Viewer not authorized to delete" (no `type`)
      // — GitHub lets only a repo admin's USER credential delete an issue. The
      // tool words that for the model (github.ts).
      const forbidden = body.errors.some(
        (e) => e.type === "FORBIDDEN" || /permission|not accessible|not authorized/i.test(e.message ?? ""),
      );
      throw new GithubApiError(forbidden ? 403 : 400, `GitHub refused to delete ${repo}#${number}: ${msg}`);
    }
  }

  // ---- Actions (docs/reference/specs/github-tools.md item 9) ----------------------------

  async getActionsRun(repo: string, runId: number): Promise<{ run: ActionsRun; jobs: ActionsJob[] }> {
    const res = await this.request("read", "GET", "actions_run", `/repos/${repo}/actions/runs/${runId}`);
    const run = toActionsRun((await res.json()) as Record<string, unknown>);
    const jobs: ActionsJob[] = [];
    for (let page = 1; page <= MAX_JOB_PAGES; page++) {
      const j = await this.request(
        "read",
        "GET",
        "actions_run_jobs",
        `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
      );
      const body = (await j.json()) as { jobs?: Array<Record<string, unknown>> };
      const rows = body.jobs ?? [];
      jobs.push(...rows.map(toActionsJob));
      if (rows.length < 100) break;
    }
    return { run, jobs };
  }

  async getActionsJob(repo: string, jobId: number): Promise<ActionsJob> {
    const res = await this.request("read", "GET", "actions_job", `/repos/${repo}/actions/jobs/${jobId}`);
    return toActionsJob((await res.json()) as Record<string, unknown>);
  }

  async getActionsJobLog(repo: string, jobId: number, maxChars = ACTIONS_LOG_MAX_CHARS): Promise<ActionsJobLog> {
    // GitHub answers the log with a 302 to a short-lived signed URL on a blob
    // host. The redirect is followed by hand so the App credential never
    // leaves for that host: the signed URL is its own credential.
    const first = await this.request(
      "read",
      "GET",
      "actions_job_logs",
      `/repos/${repo}/actions/jobs/${jobId}/logs`,
      undefined,
      "application/vnd.github+json",
      { redirect: "manual" },
    );
    let res = first;
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get("location");
      await first.body?.cancel().catch(() => undefined);
      if (!location)
        throw classifyError(
          new GithubApiError(502, `GitHub answered HTTP ${first.status} for the job log without a location`),
          { kind: "http", code: String(first.status) },
        );
      res = await tracedFetch(
        this.parent,
        location,
        { method: "GET", headers: { "user-agent": "switchboard" }, signal: AbortSignal.timeout(LOG_TIMEOUT_MS) },
        { route: "actions_job_logs_blob", name: "github.rest", fetchImpl: this.fetchImpl },
      );
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw classifyError(new GithubApiError(res.status, `the job log's blob URL answered HTTP ${res.status}`), {
          kind: "http",
          code: String(res.status),
        });
      }
    }
    return readTailCapped(res, maxChars);
  }

  /** One call. Non-2xx throws `GithubApiError` with the status and the start
   *  of GitHub's message. */
  private async request(
    scope: GithubTokenScope,
    method: "GET" | "POST" | "PATCH",
    route: GithubRoute,
    path: string,
    body?: unknown,
    accept = "application/vnd.github+json",
    opts: { redirect?: "manual" } = {},
  ): Promise<Response> {
    const token = await this.token(scope, this.parent);
    if (!token) throw new GithubApiError(401, "no GitHub credential available (configure the GitHub App or GH_TOKEN)");
    // One `github.rest` span under the view's parent (docs/reference/specs/tracing.md item
    // 23): the route word, the method and the status — never the path. GitHub
    // is not one of our hosts, so no trace context leaves with the request.
    const res = await tracedFetch(
      this.parent,
      `https://api.github.com${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept,
          "user-agent": "switchboard",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(opts.redirect ? { redirect: opts.redirect } : {}),
      },
      { route, name: "github.rest", fetchImpl: this.fetchImpl },
    );
    const redirected = opts.redirect === "manual" && res.status >= 300 && res.status < 400;
    if (!res.ok && !redirected) {
      const text = await res.text().catch(() => "");
      // Item 62: a GitHub error body is remote text — redact BEFORE the slice.
      let detail = redactAndCap(text, 300);
      try {
        const j = JSON.parse(text) as { message?: string };
        if (typeof j.message === "string") detail = redactAndCap(j.message, 300);
      } catch {
        /* keep the raw slice */
      }
      // Classified for the spans above it (docs/reference/specs/tracing.md item 2): the
      // status is the peer's own discriminator, the body never an attr.
      throw classifyError(
        new GithubApiError(res.status, `GitHub ${method} ${path} failed: HTTP ${res.status} ${detail}`.trim()),
        { kind: "http", code: String(res.status) },
      );
    }
    return res;
  }
}

/** `updatedAt` as epoch ms for ordering; an unparseable seed sorts oldest. */
const updatedMs = (i: IssueSummary): number => {
  const t = Date.parse(i.updatedAt);
  return Number.isFinite(t) ? t : 0;
};

/** Decode a response body as UTF-8 up to `maxChars`, cancelling the stream
 *  once that many characters are in hand — a multi-MB raw blob costs the
 *  clip's worth of memory, not its own size. Bodies that cannot stream (no
 *  `body`) fall back to `text()`. */
export async function readTextCapped(res: Response, maxChars: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxChars);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < maxChars) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    if (text.length < maxChars) text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, maxChars);
}

/** Read a response's text keeping only its LAST `maxChars` characters: a job
 *  log's failure is at its end, and a multi-MB log must cost the cap's memory,
 *  not its own. `complete` says whether anything was dropped. */
export async function readTailCapped(res: Response, maxChars: number): Promise<ActionsJobLog> {
  if (!res.body) {
    const all = await res.text();
    return { text: all.slice(-maxChars), complete: all.length <= maxChars };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let dropped = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      // Trim once the buffer is twice the cap, so the slice is amortised over
      // the stream instead of running per chunk.
      if (text.length > maxChars * 2) {
        text = text.slice(-maxChars);
        dropped = true;
      }
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (text.length > maxChars) {
    text = text.slice(-maxChars);
    dropped = true;
  }
  return { text, complete: !dropped };
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toActionsRun(row: Record<string, unknown>): ActionsRun {
  return {
    id: Number(row.id),
    name: str(row.name),
    displayTitle: str(row.display_title),
    workflowPath: str(row.path),
    status: str(row.status, "unknown"),
    conclusion: strOrNull(row.conclusion),
    event: str(row.event),
    headBranch: str(row.head_branch),
    headSha: str(row.head_sha),
    runNumber: Number(row.run_number ?? 0),
    runAttempt: Number(row.run_attempt ?? 1),
    url: str(row.html_url),
    createdAt: str(row.created_at),
    runStartedAt: str(row.run_started_at, str(row.created_at)),
    updatedAt: str(row.updated_at),
  };
}

function toActionsJob(row: Record<string, unknown>): ActionsJob {
  const steps = Array.isArray(row.steps) ? (row.steps as Array<Record<string, unknown>>) : [];
  return {
    id: Number(row.id),
    runId: Number(row.run_id ?? 0),
    name: str(row.name),
    status: str(row.status, "unknown"),
    conclusion: strOrNull(row.conclusion),
    url: str(row.html_url),
    startedAt: strOrNull(row.started_at),
    completedAt: strOrNull(row.completed_at),
    runnerName: strOrNull(row.runner_name),
    steps: steps.map((s) => ({
      number: Number(s.number ?? 0),
      name: str(s.name),
      status: str(s.status, "unknown"),
      conclusion: strOrNull(s.conclusion),
      startedAt: strOrNull(s.started_at),
      completedAt: strOrNull(s.completed_at),
    })),
  };
}

function encodePath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function toIssue(row: Record<string, unknown>): IssueSummary {
  const labels = Array.isArray(row.labels)
    ? (row.labels as Array<Record<string, unknown> | string>)
        .map((l) => (typeof l === "string" ? l : String(l.name ?? "")))
        .filter(Boolean)
    : [];
  const assignees = Array.isArray(row.assignees)
    ? (row.assignees as Array<Record<string, unknown>>).map((a) => String(a.login ?? "")).filter(Boolean)
    : [];
  return {
    number: Number(row.number),
    title: String(row.title ?? ""),
    state: row.state === "closed" ? "closed" : "open",
    url: String(row.html_url ?? ""),
    labels,
    assignees,
    author: String((row.user as Record<string, unknown> | undefined)?.login ?? "?"),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    ...(typeof row.body === "string" ? { body: row.body } : {}),
    ...(typeof row.comments === "number" ? { comments: row.comments } : {}),
  };
}

// ---- in-memory implementation ---------------------------------------------------

export interface InMemoryRepo {
  files?: Record<string, string>;
  issues?: IssueSummary[];
  defaultBranch?: string;
  private?: boolean;
  description?: string | null;
  /** Seeded comparisons by `base...head`: the diff text, or the HTTP status
   *  GitHub would answer (406 for a diff too large to render). */
  compares?: Record<string, string | { status: number }>;
  /** Seeded workflow runs (item 9). */
  actions?: InMemoryActionsRun[];
}

/** A seeded run with its jobs; a job may carry its log text. */
export interface InMemoryActionsJob extends ActionsJob {
  log?: string;
}
export interface InMemoryActionsRun extends ActionsRun {
  jobs: InMemoryActionsJob[];
}

/** The test double and the second implementation: a map of repos with files
 *  and issues; unknown repos 404 like GitHub does for repos outside the
 *  installation. */
export class InMemoryGithubApi implements GithubApi {
  readonly repos = new Map<string, Required<Pick<InMemoryRepo, "files" | "issues">> & InMemoryRepo>();
  readonly comments = new Map<string, IssueComment[]>();
  readonly deleted: string[] = [];
  private nextNumber = 1;
  /** A monotonic clock (one second per write, starting after the newest
   *  seeded issue) so `updatedAt` orders issues the way GitHub's
   *  `sort=updated&direction=desc` does in production — deterministic for
   *  tests. */
  private clock = 0;

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  constructor(repos: Record<string, InMemoryRepo> = {}) {
    for (const [name, r] of Object.entries(repos)) {
      this.repos.set(name.toLowerCase(), { ...r, files: r.files ?? {}, issues: r.issues ?? [] });
      for (const i of r.issues ?? []) {
        this.nextNumber = Math.max(this.nextNumber, i.number + 1);
        const t = Date.parse(i.updatedAt);
        if (Number.isFinite(t)) this.clock = Math.max(this.clock, t);
      }
    }
  }

  private repo(name: string) {
    const r = this.repos.get(name.toLowerCase());
    if (!r) throw new GithubApiError(404, `GitHub GET /repos/${name} failed: HTTP 404 Not Found`);
    return r;
  }

  async listRepos(): Promise<InstallationRepo[]> {
    return [...this.repos.entries()].map(([fullName, r]) => ({
      fullName,
      private: r.private ?? true,
      defaultBranch: r.defaultBranch ?? "main",
      description: r.description ?? null,
    }));
  }

  async readFile(repo: string, path: string, ref?: string, opts?: ReadFileOptions): Promise<RepoFile> {
    const maxChars = opts?.maxChars ?? MAX_FILE_CHARS;
    const r = this.repo(repo);
    const clean = path.replace(/^\/+/, "");
    const content = r.files[clean];
    if (content === undefined) {
      if (Object.keys(r.files).some((f) => f.startsWith(`${clean}/`)))
        throw new GithubApiError(400, `${path} is a directory — list it with github_tree`);
      throw new GithubApiError(404, `GitHub GET /repos/${repo}/contents/${clean} failed: HTTP 404 Not Found`);
    }
    const truncated = content.length > maxChars;
    return {
      path: clean,
      content: truncated ? content.slice(0, maxChars) : content,
      size: content.length,
      truncated,
      sha: "0".repeat(40),
      url: `https://github.com/${repo}/blob/${ref ?? r.defaultBranch ?? "main"}/${clean}`,
    };
  }

  async listTree(repo: string, path = ""): Promise<TreeEntry[]> {
    const r = this.repo(repo);
    const prefix = path.replace(/^\/+|\/+$/g, "");
    if (prefix && r.files[prefix] !== undefined)
      throw new GithubApiError(400, `${path} is a file — read it with github_file`);
    const seen = new Map<string, TreeEntry>();
    for (const f of Object.keys(r.files)) {
      if (prefix && !f.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? f.slice(prefix.length + 1) : f;
      const [head, ...more] = rest.split("/");
      const p = prefix ? `${prefix}/${head}` : head;
      if (!seen.has(p))
        seen.set(p, more.length ? { path: p, type: "dir" } : { path: p, type: "file", size: r.files[f].length });
    }
    if (prefix && seen.size === 0)
      throw new GithubApiError(404, `GitHub GET /repos/${repo}/contents/${prefix} failed: HTTP 404 Not Found`);
    return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async searchCode(query: string, repo?: string, limit = 10): Promise<CodeSearchHit[]> {
    const hits: CodeSearchHit[] = [];
    for (const [name, r] of this.repos) {
      if (repo && name !== repo.toLowerCase()) continue;
      for (const [path, content] of Object.entries(r.files)) {
        const idx = content.indexOf(query);
        if (idx >= 0)
          hits.push({
            repo: name,
            path,
            url: `https://github.com/${name}/blob/main/${path}`,
            fragments: [content.slice(Math.max(0, idx - 40), idx + query.length + 40)],
          });
      }
    }
    return hits.slice(0, limit);
  }

  async listIssues(
    repo: string,
    opts: { state?: "open" | "closed" | "all"; labels?: string[]; limit?: number } = {},
  ): Promise<IssueSummary[]> {
    const state = opts.state ?? "open";
    return this.repo(repo)
      .issues.filter((i) => state === "all" || i.state === state)
      .filter((i) => !opts.labels?.length || opts.labels.every((l) => i.labels.includes(l)))
      .sort((a, b) => updatedMs(b) - updatedMs(a))
      .slice(0, opts.limit ?? 20);
  }

  async getIssue(repo: string, number: number): Promise<{ issue: IssueSummary; comments: IssueComment[] }> {
    const issue = this.repo(repo).issues.find((i) => i.number === number);
    if (!issue) throw new GithubApiError(404, `GitHub GET /repos/${repo}/issues/${number} failed: HTTP 404 Not Found`);
    return { issue, comments: this.comments.get(`${repo.toLowerCase()}#${number}`) ?? [] };
  }

  async createIssue(repo: string, input: NewIssueInput): Promise<IssueSummary> {
    const r = this.repo(repo);
    const now = this.tick();
    const issue: IssueSummary = {
      number: this.nextNumber++,
      title: input.title,
      state: "open",
      url: `https://github.com/${repo.toLowerCase()}/issues/${this.nextNumber - 1}`,
      labels: input.labels ?? [],
      assignees: input.assignees ?? [],
      author: "switchboard[bot]",
      createdAt: now,
      updatedAt: now,
      body: clipBody(input.body) ?? "",
      comments: 0,
    };
    r.issues.push(issue);
    return issue;
  }

  async updateIssue(repo: string, number: number, patch: IssuePatch): Promise<IssueSummary> {
    const { issue } = await this.getIssue(repo, number);
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = clipBody(patch.body);
    if (patch.state !== undefined) issue.state = patch.state;
    if (patch.labels !== undefined) issue.labels = patch.labels;
    if (patch.assignees !== undefined) issue.assignees = patch.assignees;
    issue.updatedAt = this.tick();
    return issue;
  }

  async commentIssue(repo: string, number: number, body: string): Promise<{ url: string }> {
    const { issue } = await this.getIssue(repo, number);
    const key = `${repo.toLowerCase()}#${number}`;
    const list = this.comments.get(key) ?? [];
    const now = this.tick();
    list.push({ author: "switchboard[bot]", createdAt: now, body: clipBody(body) ?? "" });
    this.comments.set(key, list);
    issue.comments = list.length;
    issue.updatedAt = now;
    return { url: `${issue.url}#issuecomment-${list.length}` };
  }

  async deleteIssue(repo: string, number: number): Promise<void> {
    const r = this.repo(repo);
    const idx = r.issues.findIndex((i) => i.number === number);
    if (idx < 0) throw new GithubApiError(404, `GitHub GET /repos/${repo}/issues/${number} failed: HTTP 404 Not Found`);
    r.issues.splice(idx, 1);
    this.deleted.push(`${repo.toLowerCase()}#${number}`);
  }

  private actionsRun(repo: string, runId: number): InMemoryActionsRun {
    const run = (this.repo(repo).actions ?? []).find((r) => r.id === runId);
    if (!run)
      throw new GithubApiError(404, `GitHub GET /repos/${repo}/actions/runs/${runId} failed: HTTP 404 Not Found`);
    return run;
  }

  private actionsJob(repo: string, jobId: number): InMemoryActionsJob {
    for (const run of this.repo(repo).actions ?? []) {
      const job = run.jobs.find((j) => j.id === jobId);
      if (job) return job;
    }
    throw new GithubApiError(404, `GitHub GET /repos/${repo}/actions/jobs/${jobId} failed: HTTP 404 Not Found`);
  }

  async getActionsRun(repo: string, runId: number): Promise<{ run: ActionsRun; jobs: ActionsJob[] }> {
    const { jobs, ...run } = this.actionsRun(repo, runId);
    return { run, jobs: jobs.map(({ log: _log, ...job }) => job) };
  }

  async getActionsJob(repo: string, jobId: number): Promise<ActionsJob> {
    const { log: _log, ...job } = this.actionsJob(repo, jobId);
    return job;
  }

  async getActionsJobLog(repo: string, jobId: number, maxChars = ACTIONS_LOG_MAX_CHARS): Promise<ActionsJobLog> {
    const text = this.actionsJob(repo, jobId).log ?? "";
    return { text: text.slice(-maxChars), complete: text.length <= maxChars };
  }

  async compareDiff(repo: string, base: string, head: string, maxChars = COMPARE_DIFF_MAX_CHARS): Promise<CompareDiff> {
    const seeded = this.repo(repo).compares?.[`${base}...${head}`];
    const path = `/repos/${repo}/compare/${base}...${head}`;
    if (seeded === undefined) throw new GithubApiError(404, `GitHub GET ${path} failed: HTTP 404 Not Found`);
    if (typeof seeded !== "string")
      throw new GithubApiError(seeded.status, `GitHub GET ${path} failed: HTTP ${seeded.status}`);
    return seeded.length > maxChars
      ? { diff: seeded.slice(0, maxChars), complete: false }
      : { diff: seeded, complete: true };
  }
}
