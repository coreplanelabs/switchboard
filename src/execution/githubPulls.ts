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

/**
 * Create `refs/heads/<branch>` at the current tip of `fromRef` (ship round 0,
 * features/agent-ship.md item 3 / KTD12). The resident binds a thread's
 * worktree to a ref that must already exist on origin — an attach naming a
 * branch GitHub has never heard of is refused, and the executor factory's
 * sandbox fallback would then misreport "onboard the repo" on every fresh
 * pipeline — so the BOT creates the pipeline branch itself BEFORE the first
 * attach. Two REST calls with the App token (`contents:write`), same
 * conventions as the PR writes above, never a `gh` shell-out:
 *
 *   GET  /repos/{repo}/git/ref/heads/{fromRef}  → the base tip's sha
 *   POST /repos/{repo}/git/refs                 → refs/heads/<branch> at it
 *
 * A 422 "already exists" on the create is SUCCESS: a restarted pipeline
 * recreates the same deterministic branch name, and the existing ref — with
 * any work already pushed to it — is exactly what the restart wants
 * (recreatability, AGENTS.md invariant 6). Everything else throws so the
 * caller can abort honestly instead of dispatching a round that cannot bind.
 */
export async function createBranchRef(repo: string, branch: string, fromRef: string): Promise<void> {
  const token = await requireToken();
  // Segment-encode the base ref: slashes are path structure (`release/1.x`),
  // everything else inside a segment is escaped.
  const basePath = fromRef.split("/").map(encodeURIComponent).join("/");
  const baseRes = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${basePath}`, {
    headers: apiHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!baseRes.ok) {
    const text = await baseRes.text().catch(() => "");
    throw new Error(`base ref lookup failed for ${fromRef}: HTTP ${baseRes.status} ${text.slice(0, 300)}`);
  }
  const base = (await baseRes.json().catch(() => null)) as { object?: { sha?: unknown } } | null;
  const sha = typeof base?.object?.sha === "string" && base.object.sha ? base.object.sha : undefined;
  if (!sha) throw new Error(`base ref lookup for ${fromRef} answered without a sha`);
  const res = await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
    method: "POST",
    headers: apiHeaders(token, true),
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  if (res.status === 422 && /already exists/i.test(text)) return;
  throw new Error(`branch create failed for ${branch}: HTTP ${res.status} ${text.slice(0, 300)}`);
}

// ---- read-only repo/PR facts for the ship gate (features/agent-ship.md) ----
// Same REST-with-App-token conventions as the writes above; both lookups are
// advisory reads whose UNKNOWN answer the caller treats fail-closed, so they
// return undefined on any failure instead of throwing.

/** What the ship preflight needs to know about a repository before round 0:
 *  whether auto-merge is enabled (spec item 9 — unknown counts as enabled),
 *  and the default branch (the PR base of last resort). */
export interface RepoShipInfo {
  /** `allow_auto_merge` as GitHub reports it; absent when the response did not
   *  carry the field (a token without enough scope) — the caller fail-closes. */
  allowAutoMerge?: boolean;
  defaultBranch?: string;
}

/** The PR base of last resort: explicit candidates in priority order, else the
 *  repo's own default branch. Pure/sync — for a caller that already holds a
 *  RepoShipInfo for another reason (agent:ship's preflight fetches it
 *  unconditionally for the auto-merge gate, spec item 9). `resolveBaseRefLazy`
 *  below is for a caller with no other reason to fetch one. Shared so "ask
 *  GitHub for the default branch" stays one mechanism, not one per caller. */
export function resolveBaseRef(candidates: Array<string | undefined>, defaultBranch: string | undefined): string | undefined {
  return candidates.find((c): c is string => c !== undefined) ?? defaultBranch;
}

/** Same resolution, but fetches the repo's default branch itself — ONLY when
 *  none of the explicit candidates already name one, so a run that already
 *  knows its base (a bound PR, a resident binding, an explicit ref) never
 *  pays for a GitHub call it doesn't need. `fetchInfo` is never awaited past
 *  a failure: an unreachable/unauthorized lookup just leaves no last resort,
 *  same as `fetchRepoShipInfo` itself. */
export async function resolveBaseRefLazy(
  candidates: Array<string | undefined>,
  repo: string,
  fetchInfo: (repo: string) => Promise<RepoShipInfo | undefined>,
): Promise<string | undefined> {
  const explicit = candidates.find((c): c is string => c !== undefined);
  if (explicit) return explicit;
  const info = await fetchInfo(repo).catch(() => undefined);
  return info?.defaultBranch;
}

/** GET /repos/{repo} → the ship-gate facts, or undefined when the credential
 *  is missing, the fetch fails, or the answer is malformed. Never throws. */
export async function fetchRepoShipInfo(repo: string): Promise<RepoShipInfo | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  if (!token) return undefined;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => null)) as { allow_auto_merge?: unknown; default_branch?: unknown } | null;
  if (!data || typeof data !== "object") return undefined;
  return {
    ...(typeof data.allow_auto_merge === "boolean" ? { allowAutoMerge: data.allow_auto_merge } : {}),
    ...(typeof data.default_branch === "string" && data.default_branch ? { defaultBranch: data.default_branch } : {}),
  };
}

/** One PR's entry-check facts for ship (spec item 10): open/closed, the author
 *  identity (login AND immutable numeric id — the same pair the org
 *  auto-approve workflow pins), whether the head lives on the base repo, and
 *  the head branch/sha for the resume path. */
export interface PullRequestFacts {
  state: "open" | "closed";
  author?: { login?: string; id?: number };
  /** Head branch name (a fork's head ref is still reported; `sameRepoHead`
   *  says whether it lives on the base repo). */
  headRef?: string;
  /** Head sha (40-hex) when well-formed. */
  headSha?: string;
  /** True only on a POSITIVE match of head repo == base repo — a deleted-fork
   *  null head repo is false, never assumed same-repo. */
  sameRepoHead: boolean;
  /** The PR's own base branch — the resume path's true merge base (a PR
   *  opened against a non-default base must not resume against the default). */
  baseRef?: string;
  htmlUrl?: string;
}

/** GET /repos/{repo}/pulls/{n} → the entry-check facts, or undefined when the
 *  fetch fails or the state is unrecognizable. Never throws. */
export async function fetchPullRequestFacts(pr: { repo: string; number: number }): Promise<PullRequestFacts | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  const headers = apiHeaders(token); // no credential → unauthenticated (public repos answer)
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${pr.repo}/pulls/${pr.number}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => null)) as {
    state?: unknown;
    html_url?: unknown;
    user?: { login?: unknown; id?: unknown };
    head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } };
    base?: { ref?: unknown };
  } | null;
  if (!data || (data.state !== "open" && data.state !== "closed")) return undefined;
  const headRepo = typeof data.head?.repo?.full_name === "string" ? data.head.repo.full_name.toLowerCase() : undefined;
  const sha = typeof data.head?.sha === "string" && /^[0-9a-f]{40}$/.test(data.head.sha) ? data.head.sha : undefined;
  return {
    state: data.state,
    ...(data.user && (typeof data.user.login === "string" || typeof data.user.id === "number")
      ? {
          author: {
            ...(typeof data.user.login === "string" ? { login: data.user.login } : {}),
            ...(typeof data.user.id === "number" ? { id: data.user.id } : {}),
          },
        }
      : {}),
    ...(typeof data.head?.ref === "string" && data.head.ref ? { headRef: data.head.ref } : {}),
    ...(sha ? { headSha: sha } : {}),
    sameRepoHead: headRepo === pr.repo.toLowerCase(),
    ...(typeof data.base?.ref === "string" && data.base.ref ? { baseRef: data.base.ref } : {}),
    ...(typeof data.html_url === "string" ? { htmlUrl: data.html_url } : {}),
  };
}

async function requireToken(): Promise<string> {
  const token = await resolveGithubToken();
  if (!token) {
    throw new Error("no GitHub credential available to open or edit the pull request");
  }
  return token;
}

/** The module's standard REST headers; a null/empty token sends no
 *  authorization header (the unauthenticated public-repo path). */
function apiHeaders(token: string | null, withBody = false): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "switchboard",
  };
  if (token) headers.authorization = `Bearer ${token}`;
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
