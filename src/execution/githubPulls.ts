import { resolveGithubToken } from "./githubApp.js";

// Opening and editing pull requests from the bot process (agent:ship pipeline,
// issue #131). After a coding run pushes its branch and submits the typed
// PrDescription, the BOT renders the body and opens the PR itself over the
// GitHub REST API with the App installation token — never the model from
// inside the sandbox/resident and never a `gh` shell-out (AGENTS.md
// invariant 5). The App needs `pull_requests:write`. This is the same
// REST-with-App-token path githubComments.ts and repoContext.ts use.
//
// Open-or-edit idempotency (ship plan KTD9/R11): openPullRequest ALWAYS looks
// up the open PR for the head branch first and edits it when one exists — a
// fix round, a re-run, or a restarted pipeline can never open a duplicate PR.
//
// Input provenance is fixed by the types, never by prose: `title` comes from
// the validated PrDescription.title, `headBranch` from the branch the run was
// observed to push, `base` from the caller's resolved base ref. The rendered
// `body` is an opaque string — prose inside it (say, a line reading
// "base: main") is data in the body field and cannot alter what is sent for
// title/head/base.

// GitHub rejects a PR body over 65536 chars; clip with a visible note so a
// huge description still lands instead of 422-ing.
const MAX_BODY_CHARS = 65000;

const REQUEST_TIMEOUT_MS = 15_000;

export interface PullRequestTarget {
  /** `owner/name` */
  repo: string;
  /** Branch the run was OBSERVED to push (bare name, no owner prefix). */
  headBranch: string;
  /** Base ref resolved by the caller (thread binding ref / repo default). */
  base: string;
  /** The validated PrDescription.title — the PR title's single source. */
  title: string;
  /** Rendered PR body markdown; opaque, sent verbatim (clipped if huge). */
  body: string;
}

export interface OpenPrRef {
  number: number;
  htmlUrl: string;
  /** Head sha as GitHub reported it, when present in the listing. */
  headSha?: string;
}

export interface OpenedPullRequest {
  number: number;
  htmlUrl: string;
  /** true → a new PR was created; false → the existing open PR was edited. */
  created: boolean;
}

/**
 * The open PR whose head is `branch`, or null when there is none. The lookup
 * is `state=open` + `head=owner:branch` (owner derived from the repo slug), so
 * a closed or merged PR on the same branch never shadows a fresh create.
 * Taking the first row is exhaustive, not a shortcut: GitHub allows at most
 * ONE open PR per head branch (regardless of base), so the list has 0 or 1.
 * Throws on missing credential or a non-2xx response.
 */
export async function findOpenPrByHead(repo: string, branch: string): Promise<OpenPrRef | null> {
  const token = await requireToken();
  const owner = repo.split("/")[0];
  const res = await fetch(
    `https://api.github.com/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PR lookup failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const rows = (await res.json()) as Array<{ number: number; html_url: string; head?: { sha?: string } }>;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0];
  return {
    number: first.number,
    htmlUrl: first.html_url,
    ...(first.head?.sha ? { headSha: first.head.sha } : {}),
  };
}

/**
 * Open the PR for `target.headBranch`, or edit the one already open —
 * lookup-first, create only when absent, never a second create. The create
 * payload's `head` is the bare branch name (owner-qualified form belongs only
 * in the lookup query, per the GitHub API). Throws on missing credential or a
 * non-2xx response so the caller can report honestly instead of fabricating a
 * URL.
 */
export async function openPullRequest(target: PullRequestTarget): Promise<OpenedPullRequest> {
  const existing = await findOpenPrByHead(target.repo, target.headBranch);
  if (existing) {
    await updatePullRequest(target.repo, existing.number, { title: target.title, body: target.body });
    return { number: existing.number, htmlUrl: existing.htmlUrl, created: false };
  }
  const token = await requireToken();
  const res = await fetch(`https://api.github.com/repos/${target.repo}/pulls`, {
    method: "POST",
    headers: apiHeaders(token, true),
    body: JSON.stringify({
      title: target.title,
      head: target.headBranch,
      base: target.base,
      body: clipBody(target.body),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PR create failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { number: number; html_url: string };
  return { number: data.number, htmlUrl: data.html_url, created: true };
}

/**
 * Edit a PR the caller already knows by number (a fix round re-rendering the
 * body at the new head). Throws on missing credential or a non-2xx response.
 */
export async function updatePullRequest(
  repo: string,
  number: number,
  patch: { title: string; body: string },
): Promise<void> {
  const token = await requireToken();
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
    method: "PATCH",
    headers: apiHeaders(token, true),
    body: JSON.stringify({ title: patch.title, body: clipBody(patch.body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PR update failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
}

async function requireToken(): Promise<string> {
  const token = await resolveGithubToken();
  if (!token) {
    throw new Error("no GitHub credential available to open or edit the pull request");
  }
  return token;
}

function apiHeaders(token: string, withBody = false): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "switchboard",
  };
  if (withBody) headers["content-type"] = "application/json";
  return headers;
}

function clipBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  // The slice is by UTF-16 code units and can land inside a surrogate pair; a
  // trailing lone high surrogate would leave the clipped body ill-formed, so
  // it is dropped with the rest of the tail.
  let clipped = body.slice(0, MAX_BODY_CHARS);
  const last = clipped.charCodeAt(clipped.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) clipped = clipped.slice(0, -1);
  return `${clipped}\n\n_(description truncated to fit GitHub's body size limit)_`;
}
