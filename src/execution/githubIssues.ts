import { resolveGithubToken } from "./githubApp.js";

// Filing GitHub issues from the bot process (Area 7b / #84): the IssueTracker
// seam the friction proposer files its proposals through. GithubIssueTracker
// speaks the GitHub REST API with the App installation token — the same
// REST-with-App-token path githubComments.ts and repoContext.ts use, never a
// `gh` shell-out and never from inside a sandbox (AGENTS.md invariant 5). The
// App needs `issues:write`. InMemoryIssueTracker is the second implementation
// (invariant 2) and the unit-test double. Creating an issue is the proposer's
// ONLY side effect: no PRs, no approvals, no merges.

export interface IssueRef {
  number: number;
  url: string;
  title: string;
  body: string;
}

export interface NewIssue {
  title: string;
  body: string;
  labels: string[];
}

export interface IssueTracker {
  /** Open issues (never PRs) carrying `label`, newest first as GitHub returns them. */
  listOpen(repo: string, label: string): Promise<IssueRef[]>;
  /** Open one issue. Throws on failure with enough detail to report. */
  create(repo: string, issue: NewIssue): Promise<IssueRef>;
}

/** GitHub rejects an issue body over 65536 chars; clip with a visible note. */
const MAX_BODY_CHARS = 65000;
const PER_PAGE = 100;
/** Pagination ceiling — 500 open proposals would itself be the finding. */
const MAX_PAGES = 5;
/** Newest open issues fetched WITHOUT the label filter (see listOpen). */
const NEWEST_UNFILTERED = 30;
const REQUEST_TIMEOUT_MS = 15_000;
/** Label color/description used when the triage label does not exist yet. */
const LABEL_COLOR = "0e8a16";
const LABEL_DESCRIPTION = "Proposed by Switchboard's self-improvement pass (#84) — triage, then fix or close";

export interface GithubIssueTrackerOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Credential resolver; defaults to the App installation token (or GH_TOKEN). */
  token?: () => Promise<string | null>;
}

export class GithubIssueTracker implements IssueTracker {
  private readonly fetchImpl: typeof fetch;
  private readonly token: () => Promise<string | null>;
  /** `repo/label` pairs verified to exist this process — one lookup per pair. */
  private readonly knownLabels = new Set<string>();

  constructor(opts: GithubIssueTrackerOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.token = opts.token ?? (() => resolveGithubToken());
  }

  /**
   * Label-filtered listing, paginated, PLUS the newest open issues unfiltered.
   * The unfiltered page exists because GitHub's label-filtered list was observed
   * to lag a few seconds behind issue creation (validation of #138: a pass re-run
   * right after filing refiled the same pattern). Dedupe keys on the marker in
   * the body — not the label — so the freshest issues are covered even before
   * the label index catches up.
   */
  async listOpen(repo: string, label: string): Promise<IssueRef[]> {
    const seen = new Map<number, IssueRef>();
    const collect = (rows: unknown) => {
      if (!Array.isArray(rows)) return 0;
      for (const row of rows as Array<Record<string, unknown>>) {
        if (row.pull_request) continue; // the issues API lists PRs too
        const ref = toRef(row);
        if (!seen.has(ref.number)) seen.set(ref.number, ref);
      }
      return rows.length;
    };
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.request(
        "GET",
        `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=${PER_PAGE}&page=${page}`,
      );
      if (collect(await res.json()) < PER_PAGE) break;
    }
    const newest = await this.request("GET", `/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=${NEWEST_UNFILTERED}`);
    collect(await newest.json());
    return [...seen.values()];
  }

  async create(repo: string, issue: NewIssue): Promise<IssueRef> {
    for (const label of issue.labels) await this.ensureLabel(repo, label);
    const body =
      issue.body.length > MAX_BODY_CHARS
        ? `${issue.body.slice(0, MAX_BODY_CHARS)}\n\n_(truncated to fit GitHub's issue size limit)_`
        : issue.body;
    const res = await this.request("POST", `/repos/${repo}/issues`, { title: issue.title, body, labels: issue.labels });
    return toRef((await res.json()) as Record<string, unknown>);
  }

  /** Create the triage label when the repo lacks it, so the first proposal ever
   *  filed is already triageable. A 422 on create means it appeared meanwhile. */
  private async ensureLabel(repo: string, label: string): Promise<void> {
    const key = `${repo}/${label}`;
    if (this.knownLabels.has(key)) return;
    const probe = await this.request("GET", `/repos/${repo}/labels/${encodeURIComponent(label)}`, undefined, [404]);
    if (probe.status === 404) {
      await this.request("POST", `/repos/${repo}/labels`, { name: label, color: LABEL_COLOR, description: LABEL_DESCRIPTION }, [422]);
    }
    this.knownLabels.add(key);
  }

  /** One REST call. Non-2xx (other than `tolerate`d statuses) throws with the
   *  status and the start of GitHub's message. */
  private async request(method: "GET" | "POST", path: string, body?: unknown, tolerate: number[] = []): Promise<Response> {
    const token = await this.token();
    if (!token) throw new Error("no GitHub credential available to file issues (configure the GitHub App or GH_TOKEN)");
    const res = await this.fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "switchboard",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok && !tolerate.includes(res.status)) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    return res;
  }
}

function toRef(row: Record<string, unknown>): IssueRef {
  return {
    number: Number(row.number),
    url: String(row.html_url ?? ""),
    title: String(row.title ?? ""),
    body: typeof row.body === "string" ? row.body : "",
  };
}

// ---- in-memory implementation (tests / second impl) ---------------------------

export interface StoredIssue extends IssueRef {
  labels: string[];
  state: "open" | "closed";
}

export interface InMemoryIssueTrackerOptions {
  /** Simulate a create failure for matching titles (error-path tests). */
  failCreateWhen?: (title: string) => boolean;
}

export class InMemoryIssueTracker implements IssueTracker {
  private readonly byRepo = new Map<string, StoredIssue[]>();
  private next = 1;
  /** Every call, in order (`create <repo>` / `listOpen <repo> <label>`). */
  readonly calls: string[] = [];

  constructor(private readonly opts: InMemoryIssueTrackerOptions = {}) {}

  async listOpen(repo: string, label: string): Promise<IssueRef[]> {
    this.calls.push(`listOpen ${repo} ${label}`);
    return this.issues(repo)
      .filter((i) => i.state === "open" && i.labels.includes(label))
      .map(({ number, url, title, body }) => ({ number, url, title, body }));
  }

  async create(repo: string, issue: NewIssue): Promise<IssueRef> {
    this.calls.push(`create ${repo}`);
    if (this.opts.failCreateWhen?.(issue.title)) throw new Error("simulated create failure");
    const number = this.next++;
    const stored: StoredIssue = {
      number,
      url: `https://github.com/${repo}/issues/${number}`,
      title: issue.title,
      body: issue.body,
      labels: [...issue.labels],
      state: "open",
    };
    this.list(repo).push(stored);
    return { number, url: stored.url, title: stored.title, body: stored.body };
  }

  /** Every issue ever created in `repo` (open and closed), oldest first. */
  issues(repo: string): StoredIssue[] {
    return [...this.list(repo)];
  }

  close(repo: string, number: number): void {
    const issue = this.list(repo).find((i) => i.number === number);
    if (issue) issue.state = "closed";
  }

  private list(repo: string): StoredIssue[] {
    let list = this.byRepo.get(repo);
    if (!list) {
      list = [];
      this.byRepo.set(repo, list);
    }
    return list;
  }
}
