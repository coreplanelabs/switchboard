import { resolveGithubToken } from "./githubApp.js";
import type { CheckRunDetail } from "../core/ship/checkFindings.js";
import { redactAndCap } from "../core/redact.js";

// Opening and editing pull requests from the bot process (agent:ship
// pipeline). After a coding run pushes its branch and submits the typed
// PrDescription, the BOT renders the body and opens the PR itself over the
// GitHub REST API with the App installation token — never the model from
// inside the sandbox/resident and never a `gh` shell-out (AGENTS.md
// invariant 5). The App needs `pull_requests:write`. This is the same
// REST-with-App-token path githubComments.ts and repoContext.ts use.
//
// Open-or-edit idempotency: openPullRequest ALWAYS looks
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
  /** Whether the pull request has auto-merge set (`auto_merge !== null`);
   *  absent when the listing did not carry the field. */
  autoMergeEnabled?: boolean;
}

/** An adoption reads every PR state: a closed PR still consumed this head's
 *  one-create opportunity. An incomplete page is never proof of absence. */
export interface AnyHeadPullRequest {
  number: number;
  htmlUrl: string;
  state: "open" | "closed";
  draft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  body: string;
}

export async function listAnyPrByHead(repo: string, branch: string): Promise<AnyHeadPullRequest[]> {
  const token = await requireToken();
  const owner = repo.split("/")[0];
  const res = await fetch(
    `https://api.github.com/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`,
    { headers: apiHeaders(token), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!res.ok || /rel="next"/.test(res.headers.get("link") ?? ""))
    throw new Error(`PR all-state lookup incomplete: HTTP ${res.status}`);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows)) throw new Error("PR all-state lookup returned no list");
  return rows.map((row) => {
    const head = row.head as { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } } | undefined;
    const base = row.base as { ref?: unknown } | undefined;
    if (
      !Number.isSafeInteger(row.number) ||
      typeof row.html_url !== "string" ||
      (row.state !== "open" && row.state !== "closed") ||
      typeof row.draft !== "boolean" ||
      typeof head?.sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(head.sha) ||
      head.ref !== branch ||
      typeof head.repo?.full_name !== "string" ||
      head.repo.full_name.toLowerCase() !== repo.toLowerCase() ||
      typeof base?.ref !== "string" ||
      typeof row.body !== "string"
    )
      throw new Error("PR all-state lookup returned ambiguous facts");
    return {
      number: row.number as number,
      htmlUrl: row.html_url,
      state: row.state,
      draft: row.draft,
      headSha: head.sha,
      headRef: head.ref,
      baseRef: base.ref,
      body: row.body,
    } as AnyHeadPullRequest;
  });
}

/** One create-only draft write. A caller reconciles a lost response from the
 *  all-state listing; this function never edits or reopens an existing PR. */
export async function createDraftPullRequest(target: PullRequestTarget): Promise<OpenedPullRequest> {
  const token = await requireToken();
  const res = await fetch(`https://api.github.com/repos/${target.repo}/pulls`, {
    method: "POST",
    headers: apiHeaders(token, true),
    body: JSON.stringify({
      title: target.title,
      head: target.headBranch,
      base: target.base,
      body: clipBody(target.body),
      draft: true,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`draft PR create failed: HTTP ${res.status}`);
  const data = (await res.json()) as { number?: unknown; html_url?: unknown };
  if (!Number.isSafeInteger(data.number) || typeof data.html_url !== "string")
    throw new Error("draft PR create returned ambiguous facts");
  return { number: data.number as number, htmlUrl: data.html_url, created: true };
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
    throw new Error(`PR lookup failed: HTTP ${res.status} ${redactAndCap(text, 300)}`);
  }
  const rows = (await res.json()) as Array<{
    number: number;
    html_url: string;
    head?: { sha?: string };
    auto_merge?: unknown;
  }>;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0];
  return {
    number: first.number,
    htmlUrl: first.html_url,
    ...(first.head?.sha ? { headSha: first.head.sha } : {}),
    ...("auto_merge" in first ? { autoMergeEnabled: first.auto_merge !== null } : {}),
  };
}

export interface MergedPrRef {
  number: number;
  htmlUrl: string;
  /** The commit the merge put on the base — a squash's one commit, a merge's merge commit. */
  sha: string;
  /** When GitHub merged it, ISO 8601 — the fact that makes a closed row a merged one. */
  mergedAt: string;
}

/**
 * The merged PR whose head was `branch`, or null when none merged. The lookup
 * is `state=closed` + `head=owner:branch`, newest first, read for the rows
 * with a `merged_at` — a closed-unmerged PR still reports a `merge_commit_sha`
 * (GitHub's test merge), so the time of the merge is the fact read, never that
 * field alone — and the latest merge wins when the branch was reused. The plan
 * runner asks this after `findOpenPrByHead` came back empty: a unit whose pull
 * request a person, or an earlier attempt of the plan, merged before the runner
 * reached it is done, not aborted. Throws on missing credential or a non-2xx
 * response, like the open lookup.
 */
export async function findMergedPrByHead(repo: string, branch: string): Promise<MergedPrRef | null> {
  const token = await requireToken();
  const owner = repo.split("/")[0];
  const head = encodeURIComponent(`${owner}:${branch}`);
  const res = await fetch(
    `https://api.github.com/repos/${repo}/pulls?state=closed&head=${head}&sort=updated&direction=desc`,
    { headers: apiHeaders(token), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PR lookup failed: HTTP ${res.status} ${redactAndCap(text, 300)}`);
  }
  const rows = (await res.json()) as Array<{
    number: number;
    html_url: string;
    merged_at?: string | null;
    merge_commit_sha?: string | null;
  }>;
  if (!Array.isArray(rows)) return null;
  const merged = rows
    .flatMap((r) =>
      typeof r.merged_at === "string" &&
      typeof r.merge_commit_sha === "string" &&
      /^[0-9a-f]{40}$/.test(r.merge_commit_sha)
        ? [{ number: r.number, htmlUrl: r.html_url, sha: r.merge_commit_sha, mergedAt: r.merged_at }]
        : [],
    )
    .sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : 0));
  return merged[0] ?? null;
}

/**
 * Open the PR for `target.headBranch`, or edit the one already open —
 * lookup-first, create only when absent, never a second create. The create
 * payload's `head` is the bare branch name (owner-qualified form belongs only
 * in the lookup query, per the GitHub API). Throws on missing credential or a
 * non-2xx response so the caller can report honestly instead of fabricating a
 * URL.
 */
export async function openPullRequest(
  target: PullRequestTarget,
  beforeMutation?: (pr: number | undefined) => Promise<void>,
): Promise<OpenedPullRequest> {
  const existing = await findOpenPrByHead(target.repo, target.headBranch);
  if (existing) {
    await beforeMutation?.(existing.number);
    await updatePullRequest(target.repo, existing.number, { title: target.title, body: target.body });
    return { number: existing.number, htmlUrl: existing.htmlUrl, created: false };
  }
  const token = await requireToken();
  await beforeMutation?.(undefined);
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
    throw new Error(`PR create failed: HTTP ${res.status} ${redactAndCap(text, 300)}`);
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
    throw new Error(`PR update failed: HTTP ${res.status} ${redactAndCap(text, 300)}`);
  }
}

/** One native request, after the caller durably admits its frozen target. */
export type GithubWriteResult = { state: "accepted" } | { state: "refused"; status?: number } | { state: "uncertain" };
export type CheckRetryTarget = { operation: "actions_rerun" | "check_rerequest"; resourceId: number };
const DEFINITIVE_WRITE_REFUSALS = new Set([400, 401, 403, 404, 405, 409, 422, 429]);
const positiveNativeId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const fullHead = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
const githubRepo = (value: string): boolean =>
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && value.split("/").every((part) => part !== "." && part !== "..");

function writeRefusal(status: number): GithubWriteResult {
  return DEFINITIVE_WRITE_REFUSALS.has(status) ? { state: "refused", status } : { state: "uncertain" };
}

/** GitHub does not provide a head precondition for this PATCH. The caller
 * checks the head before admission; a raced or malformed response remains
 * uncertain even though the state change may already have happened. */
export async function setPullRequestState(
  pr: { repo: string; number: number },
  target: { headSha: string; headRef: string; baseRef: string },
  state: "closed" | "open",
): Promise<GithubWriteResult> {
  if (
    !githubRepo(pr.repo) ||
    !positiveNativeId(pr.number) ||
    !fullHead(target.headSha) ||
    !target.headRef ||
    !target.baseRef ||
    (state !== "closed" && state !== "open")
  )
    return { state: "refused" };
  const token = await requireToken().catch(() => undefined);
  if (!token) return { state: "refused" };
  try {
    const res = await fetch(`https://api.github.com/repos/${pr.repo}/pulls/${pr.number}`, {
      method: "PATCH",
      redirect: "error",
      headers: apiHeaders(token, true),
      body: JSON.stringify({ state }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 200) return writeRefusal(res.status);
    const row = (await res.json()) as {
      number?: unknown;
      state?: unknown;
      merged?: unknown;
      head?: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } };
      base?: { ref?: unknown; repo?: { full_name?: unknown } };
    } | null;
    return row?.number === pr.number &&
      row.state === state &&
      row.merged === false &&
      typeof row.head?.sha === "string" &&
      row.head.sha.toLowerCase() === target.headSha.toLowerCase() &&
      row.head.ref === target.headRef &&
      typeof row.head.repo?.full_name === "string" &&
      row.head.repo.full_name.toLowerCase() === pr.repo.toLowerCase() &&
      row.base?.ref === target.baseRef &&
      typeof row.base.repo?.full_name === "string" &&
      row.base.repo.full_name.toLowerCase() === pr.repo.toLowerCase()
      ? { state: "accepted" }
      : { state: "uncertain" };
  } catch {
    return { state: "uncertain" };
  }
}

async function postCheckRetry(
  repo: string,
  resourceId: number,
  operation: CheckRetryTarget["operation"],
): Promise<GithubWriteResult> {
  if (!githubRepo(repo) || !positiveNativeId(resourceId)) return { state: "refused" };
  const token = await requireToken().catch(() => undefined);
  if (!token) return { state: "refused" };
  const path =
    operation === "actions_rerun"
      ? `actions/runs/${resourceId}/rerun-failed-jobs`
      : `check-runs/${resourceId}/rerequest`;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      method: "POST",
      redirect: "error",
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res.status === 201 ? { state: "accepted" } : writeRefusal(res.status);
  } catch {
    return { state: "uncertain" };
  }
}

/** A native 201 acknowledges dispatch, not completion of the rerun. */
export async function rerunActionsFailedJobs(repo: string, resourceId: number): Promise<GithubWriteResult> {
  return postCheckRetry(repo, resourceId, "actions_rerun");
}

/** Rerequest does not update the check run itself. An unchanged check run
 * cannot resolve an unknown request or grant permission to replay it. */
export async function rerequestCheckRun(repo: string, resourceId: number): Promise<GithubWriteResult> {
  return postCheckRetry(repo, resourceId, "check_rerequest");
}

/** A frozen commit is posted once. HTTP/network uncertainty is not a refusal. */
export type BranchRefCreateResult =
  { state: "accepted"; commitSha: string } | { state: "refused"; status?: number } | { state: "uncertain" };
export async function createBranchRef(repo: string, branch: string, sha: string): Promise<BranchRefCreateResult> {
  if (!/^[a-f0-9]{40}$/i.test(sha)) return { state: "refused" };
  const token = await requireToken().catch(() => undefined);
  if (!token) return { state: "refused" };
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
      method: "POST",
      headers: apiHeaders(token, true),
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { state: "uncertain" };
  }
  if (res.status >= 400 && res.status < 500) return { state: "refused", status: res.status };
  if (res.status !== 201) return { state: "uncertain" };
  const body = (await res.json().catch(() => null)) as {
    ref?: unknown;
    object?: { type?: unknown; sha?: unknown };
  } | null;
  return body?.ref === `refs/heads/${branch}` &&
    body.object?.type === "commit" &&
    typeof body.object.sha === "string" &&
    body.object.sha.toLowerCase() === sha.toLowerCase()
    ? { state: "accepted", commitSha: sha }
    : { state: "uncertain" };
}

// ---- read-only repo/PR facts for the ship gate (docs/reference/specs/agent-ship.md) ----
// Same REST-with-App-token conventions as the writes above; both lookups are
// advisory reads whose UNKNOWN answer the caller treats fail-closed, so they
// return undefined on any failure instead of throwing.

/** What the ship preflight needs to know about a repository before round 0:
 *  the default branch (the PR base of last resort). A failed lookup leaves it
 *  undefined and refuses nothing — auto-merge is the pull request's own fact
 *  (`PullRequestFacts.autoMergeEnabled`), never the repository's (spec item 9). */
export interface RepoShipInfo {
  defaultBranch?: string;
}

/** The PR base of last resort: explicit candidates in priority order, else the
 *  repo's own default branch. Pure/sync — for a caller that already holds a
 *  RepoShipInfo for another reason (agent:ship's preflight fetches it
 *  unconditionally for the base of last resort). `resolveBaseRefLazy`
 *  below is for a caller with no other reason to fetch one. Shared so "ask
 *  GitHub for the default branch" stays one mechanism, not one per caller. */
export function resolveBaseRef(
  candidates: Array<string | undefined>,
  defaultBranch: string | undefined,
): string | undefined {
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
  const token = await resolveGithubToken("read").catch(() => null);
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
  const data = (await res.json().catch(() => null)) as { default_branch?: unknown } | null;
  if (!data || typeof data !== "object") return undefined;
  return {
    ...(typeof data.default_branch === "string" && data.default_branch ? { defaultBranch: data.default_branch } : {}),
  };
}

/** GET /repos/{repo}/git/ref/heads/{ref} → whether the branch exists: `true`
 *  on a 2xx, `false` on a 404 (GitHub has no such ref), `undefined` when it
 *  could not be asked (missing credential, network failure, any other status).
 *  The ship preflight's base check (agent-ship item 10, issue 1827): the same
 *  lookup `createBranchRef` starts with, spent BEFORE the pipeline branch is
 *  cut so a misbound base is a decision, not a 404 abort after the instance
 *  exists. Never throws. */
export async function fetchRefExists(repo: string, ref: string): Promise<boolean | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  if (!token) return undefined;
  const path = ref.split("/").map(encodeURIComponent).join("/");
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${path}`, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (res.ok) return true;
  return res.status === 404 ? false : undefined;
}

/** The head commit's subject line of a branch — `GET /repos/{repo}/commits/{ref}`,
 *  the commit message's first line. The runner's recover open titles by it when
 *  it passes the title rule (record 0064's `unit_title` move; agent-ship item
 *  10). Undefined when the fact could not be read — no credential, a non-2xx
 *  answer, a body without the message — never a throw. */
export async function branchHeadSubject(repo: string, branch: string): Promise<string | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  if (!token) return undefined;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => null)) as { commit?: { message?: unknown } } | null;
  const message = data?.commit?.message;
  if (typeof message !== "string" || message.trim() === "") return undefined;
  return message.split("\n", 1)[0]!.trim();
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
  /** Head sha (40-hex) when well-formed. Other readers prefer a readable ref
   * tip over a lagging PR object, so this is not itself an exact-head receipt. */
  headSha?: string;
  /** One positive, attributable remote-head receipt. Present only when the PR
   * object's head and one successful commit-ref read agree exactly; consumers
   * that must fail closed use this instead of combining best-effort fields. */
  verifiedHead?: { repo: string; ref: string; sha: string };
  /** Whether a same-repository head ref still exists. False is distinct from
   * an unreadable or malformed lookup. This field is compatibility state, not
   * proof of a tip; exact-head consumers require `verifiedHead`. */
  headBranchExists?: boolean;
  /** True only on a POSITIVE match of head repo == base repo — a deleted-fork
   *  null head repo is false, never assumed same-repo. */
  sameRepoHead: boolean;
  /** The PR's own base branch — the resume path's true merge base (a PR
   *  opened against a non-default base must not resume against the default). */
  baseRef?: string;
  htmlUrl?: string;
  /** The pull request's title as GitHub has it — the squash commit's title when the runner merges. */
  title?: string;
  /** Whether the pull request itself has auto-merge set (`auto_merge !== null`);
   *  absent when the response did not carry the field. Named at entry and at
   *  the approved head (spec item 9), never refused. */
  autoMergeEnabled?: boolean;
  /** Whether the pull request is a draft (`draft`): a draft head is held —
   *  `held: draft — mark it ready to continue` — never merged and never a
   *  cause-less exit (agent-ship item 9, issue 2063); absent when the
   *  response did not carry the field. */
  draft?: boolean;
  /** GitHub's own `mergeable`: true/false once computed, null while GitHub is
   *  still computing it; absent when the response did not carry the field. */
  mergeable?: boolean | null;
  /** GitHub's `mergeable_state` (e.g. `clean`, `dirty`, `unknown`) — `dirty`
   *  is a conflict with the base, refused at the merge door before the checks
   *  are read (spec item 9). */
  mergeableState?: string;
  /** When GitHub merged it (`merged_at`, ISO 8601) — present only on a merged
   *  pull request; a closed one carrying it ends a unit `merged`, never
   *  refused (spec item 9). */
  mergedAt?: string;
  /** The merge commit on the base (`merge_commit_sha`) of a MERGED pull
   *  request — read only beside `mergedAt`, since GitHub reports a test-merge
   *  sha under the same field on an open one. */
  mergeCommitSha?: string;
  /** The GitHub login that merged or closed the pull request, when GitHub
   * reports it. These receipts let the unit's terminal report name the person. */
  mergedBy?: string;
  closedBy?: string;
}

type HeadRefRead = { kind: "verified"; sha: string; ref?: string } | { kind: "missing" } | { kind: "unverified" };

/** One read of `refs/heads/<branch>` on `repo`. A valid commit target is the
 * only positive result; 404 is known missing; every other status, network
 * failure, or malformed body is unverified. Keeping existence and tip in one
 * result prevents a successful existence probe from lending authority to a
 * later failed tip lookup. */
async function readHeadRef(repo: string, branch: string, headers: Record<string, string>): Promise<HeadRefRead> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${encodeGithubRef(branch)}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: "unverified" };
  }
  if (res.status === 404) return { kind: "missing" };
  if (!res.ok) return { kind: "unverified" };
  const data = (await res.json().catch(() => null)) as {
    ref?: unknown;
    object?: { sha?: unknown; type?: unknown };
  } | null;
  // A branch ref points at a commit; anything else (an annotated tag object,
  // a malformed answer) is not a head to pin a review to.
  const sha = data?.object?.sha;
  return data?.object?.type === "commit" && typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha)
    ? { kind: "verified", sha, ...(typeof data.ref === "string" ? { ref: data.ref } : {}) }
    : { kind: "unverified" };
}

export type BranchRefRead =
  { kind: "verified"; sha: string; ref: string } | { kind: "missing" } | { kind: "unverified" };

/** Exact authenticated ref observation; absence never proves an earlier POST unstarted. */
export async function fetchBranchRef(repo: string, branch: string): Promise<BranchRefRead> {
  const token = await resolveGithubToken("read").catch(() => null);
  if (!token) return { kind: "unverified" };
  const read = await readHeadRef(repo, branch, apiHeaders(token));
  if (read.kind !== "verified") return read;
  return read.ref === `refs/heads/${branch}`
    ? { kind: "verified", sha: read.sha, ref: read.ref }
    : { kind: "unverified" };
}

/** Bind a pilot writer to a branch's current commit using the trusted App
 * credential. A failed or malformed read supplies no head to the model. */
export async function fetchBranchHeadSha(repo: string, branch: string): Promise<string | undefined> {
  const token = await resolveGithubToken("read").catch(() => null);
  if (!token) return undefined;
  const read = await readHeadRef(repo, branch, apiHeaders(token));
  return read.kind === "verified" ? read.sha : undefined;
}

/**
 * The tip of `refs/heads/<branch>` on `repo` — `GET /repos/{repo}/git/ref/heads/{branch}`
 * — or undefined when the ref cannot be positively read as a commit. Never
 * throws. This best-effort helper serves ordinary PR-head readers; fail-closed
 * consumers use `PullRequestFacts.verifiedHead`.
 *
 * Why the PR's head is read from the REF and not only from the PR object:
 * after a force-push GitHub's pull-request object (`head.sha`, `commits`) can
 * lag the branch ref by minutes (observed live: four minutes, while the new
 * commit object was already fetchable by sha). The ref IS the PR's head by
 * definition; the PR object follows it. A review attached at the lagging
 * `head.sha` reviews a head nobody asked about and refuses with a mismatch —
 * so ordinary PR-head readers prefer the ref's tip when the two disagree
 * (`preferRefTip`), and say so in the log. Cross-fork heads have no ref on the
 * base repo; those keep the PR object's sha.
 */
export async function headRefTipSha(
  repo: string,
  branch: string,
  headers: Record<string, string>,
): Promise<string | undefined> {
  const read = await readHeadRef(repo, branch, headers);
  return read.kind === "verified" ? read.sha : undefined;
}

/** The head sha a PR-head reader should report: the ref's tip when it is known
 *  and differs from what the PR object says (GitHub's PR object lags the ref
 *  after a force-push — see `headRefTipSha`), else the PR object's own. The
 *  disagreement is logged once per read with both shas, so a run's log says
 *  which head it took and why. */
export function preferRefTip(
  where: string,
  prSha: string | undefined,
  refTip: string | undefined,
  branch: string,
): string | undefined {
  if (refTip === undefined) return prSha;
  if (prSha !== undefined && refTip !== prSha) {
    console.log(
      `[pr-head] ${where}: GitHub's PR object reports head ${prSha.slice(0, 7)} while refs/heads/${branch} is at ${refTip.slice(0, 7)} — using the ref (the PR object lags the ref after a force-push)`,
    );
  }
  return refTip;
}

/** A branch name as a URL path for `/git/ref/heads/…`: each `/`-separated
 *  segment percent-encoded, the slashes kept (GitHub matches the ref path). */
function encodeGithubRef(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

/**
 * How many commits `branch` carries over `base` — GitHub's compare
 * (`GET /repos/{repo}/compare/{base}...{branch}`, `ahead_by`). Zero is a
 * branch with nothing to ship: the fact the plan runner's round-0 `pr-check`
 * answers so a unit whose scope already landed ends `already_landed`
 * (docs/reference/specs/agent-ship.md item 12), and the coding post-step reads
 * before offering a compare link over an empty diff. Undefined when the fact
 * could not be read — no credential, a non-2xx answer, a body without the
 * count, a network failure — never a throw: a reader that cannot know says
 * nothing rather than claiming the branch is empty.
 */
export async function commitsOverBase(repo: string, base: string, branch: string): Promise<number | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  if (!token) return undefined;
  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${repo}/compare/${encodeGithubRef(base)}...${encodeGithubRef(branch)}`,
      { headers: apiHeaders(token), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => null)) as { ahead_by?: unknown } | null;
  const ahead = data?.ahead_by;
  return typeof ahead === "number" && Number.isInteger(ahead) && ahead >= 0 ? ahead : undefined;
}

/** GET /repos/{repo}/pulls/{n} → the entry-check facts, or undefined when the
 *  fetch fails or the state is unrecognizable. The head sha is the head REF's
 *  tip when that can be read and the head lives on the base repo (see
 *  `headRefTipSha`), else the PR object's. Never throws. */
export async function fetchPullRequestFacts(pr: {
  repo: string;
  number: number;
}): Promise<PullRequestFacts | undefined> {
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
    title?: unknown;
    html_url?: unknown;
    user?: { login?: unknown; id?: unknown };
    head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } };
    base?: { ref?: unknown };
    draft?: unknown;
    auto_merge?: unknown;
    mergeable?: unknown;
    mergeable_state?: unknown;
    merged_at?: unknown;
    merge_commit_sha?: unknown;
    merged_by?: { login?: unknown };
    closed_by?: { login?: unknown };
  } | null;
  if (!data || (data.state !== "open" && data.state !== "closed")) return undefined;
  const headRepo = typeof data.head?.repo?.full_name === "string" ? data.head.repo.full_name.toLowerCase() : undefined;
  const prSha = typeof data.head?.sha === "string" && /^[0-9a-f]{40}$/.test(data.head.sha) ? data.head.sha : undefined;
  const sameRepoHead = headRepo === pr.repo.toLowerCase();
  const headRef = typeof data.head?.ref === "string" && data.head.ref ? data.head.ref : undefined;
  // One ref read owns both existence and tip. A separate successful existence
  // read must never make a failed tip read look verified.
  const headRead = sameRepoHead && headRef !== undefined ? await readHeadRef(pr.repo, headRef, headers) : undefined;
  const headBranchExists = headRead?.kind === "verified" ? true : headRead?.kind === "missing" ? false : undefined;
  const refTip = headRead?.kind === "verified" ? headRead.sha : undefined;
  // Ordinary readers still prefer a positively read ref tip over a lagging PR
  // object. The fail-closed receipt below exists only when both sources agree.
  const sha =
    sameRepoHead && headRef !== undefined ? preferRefTip(`${pr.repo}#${pr.number}`, prSha, refTip, headRef) : prSha;
  const verifiedHead =
    sameRepoHead && headRef !== undefined && prSha !== undefined && refTip === prSha
      ? { repo: pr.repo, ref: headRef, sha: refTip }
      : undefined;
  let closedBy = typeof data.closed_by?.login === "string" ? data.closed_by.login : undefined;
  // Pull-request responses consistently carry `merged_by` but older GitHub
  // shapes omit the closer. The issue representation of the same pull request
  // carries `closed_by`, so read it only for a closed-unmerged row that needs
  // the terminal receipt.
  if (data.state === "closed" && !(typeof data.merged_at === "string" && data.merged_at) && closedBy === undefined) {
    try {
      const issue = await fetch(`https://api.github.com/repos/${pr.repo}/issues/${pr.number}`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (issue.ok) {
        const row = (await issue.json().catch(() => null)) as { closed_by?: { login?: unknown } } | null;
        if (typeof row?.closed_by?.login === "string") closedBy = row.closed_by.login;
      }
    } catch {
      // The pull request state is still authoritative; only the actor is absent.
    }
  }
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
    ...(headRef !== undefined ? { headRef } : {}),
    ...(sha ? { headSha: sha } : {}),
    ...(verifiedHead !== undefined ? { verifiedHead } : {}),
    ...(headBranchExists !== undefined ? { headBranchExists } : {}),
    sameRepoHead,
    ...(typeof data.base?.ref === "string" && data.base.ref ? { baseRef: data.base.ref } : {}),
    ...(typeof data.html_url === "string" ? { htmlUrl: data.html_url } : {}),
    ...(typeof data.title === "string" && data.title ? { title: data.title } : {}),
    ...(typeof data.draft === "boolean" ? { draft: data.draft } : {}),
    ...("auto_merge" in data ? { autoMergeEnabled: data.auto_merge !== null } : {}),
    ...("mergeable" in data ? { mergeable: data.mergeable === null ? null : data.mergeable === true } : {}),
    ...(typeof data.mergeable_state === "string" && data.mergeable_state
      ? { mergeableState: data.mergeable_state }
      : {}),
    // The merge commit rides only a merged row: on an open pull request GitHub
    // reports a test-merge sha under `merge_commit_sha`.
    ...(typeof data.merged_at === "string" && data.merged_at
      ? {
          mergedAt: data.merged_at,
          ...(typeof data.merge_commit_sha === "string" && /^[0-9a-f]{40}$/.test(data.merge_commit_sha)
            ? { mergeCommitSha: data.merge_commit_sha }
            : {}),
          ...(typeof data.merged_by?.login === "string" ? { mergedBy: data.merged_by.login } : {}),
        }
      : {}),
    ...(closedBy !== undefined ? { closedBy } : {}),
  };
}

// ---- the plan runner's merge (docs/reference/specs/http-ingress.md item 9; record 0031's merge grant) ----

export type MergeResult = { ok: true; sha: string } | { ok: false; status: number; reason: string };

/** `PUT /repos/{repo}/pulls/{n}/merge`: a squash at exactly `sha` — GitHub
 *  refuses when the head moved — with `<title> (#n)` as the commit's title and
 *  an empty body (or a `Merged-by: <login>` trailer when a person's merge
 *  command names them), the shape the repository's own squash setting gives a
 *  person's merge. GitHub's refusal (405: not mergeable — a conflict, a branch
 *  protection; 409: the head is not `sha`; 422) is an answer with its status
 *  and words, never a throw; a call that fails throws, like every write here. */
export async function mergePullRequest(
  pr: { repo: string; number: number },
  opts: { sha: string; title: string; mergedBy?: string },
): Promise<MergeResult> {
  if (!/^[0-9a-f]{40}$/i.test(opts.sha)) throw new Error("merge requires an exact full head sha");
  const token = await requireToken();
  const res = await fetch(`https://api.github.com/repos/${pr.repo}/pulls/${pr.number}/merge`, {
    method: "PUT",
    headers: apiHeaders(token, true),
    body: JSON.stringify({
      merge_method: "squash",
      sha: opts.sha,
      commit_title: `${opts.title} (#${pr.number})`,
      // `mergedBy` is the person the merge command acts for (record 0062's
      // binding): the App holds the token, but the commit itself names them.
      commit_message: opts.mergedBy === undefined ? "" : `Merged-by: ${opts.mergedBy}`,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  let body: { sha?: unknown; message?: unknown; merged?: unknown } | null;
  try {
    body = JSON.parse(text) as { sha?: unknown; message?: unknown; merged?: unknown };
  } catch {
    body = null;
  }
  if (res.ok) {
    const sha = typeof body?.sha === "string" && /^[0-9a-f]{40}$/.test(body.sha) ? body.sha : undefined;
    if (sha === undefined) throw new Error(`merge of ${pr.repo}#${pr.number} answered without a merge commit sha`);
    if (res.status !== 200 || body?.merged !== true)
      throw new Error(`merge of ${pr.repo}#${pr.number} returned no native merge receipt`);
    return { ok: true, sha };
  }
  if (res.status === 405 || res.status === 409 || res.status === 422) {
    const reason = typeof body?.message === "string" && body.message ? body.message : redactAndCap(text, 300);
    return { ok: false, status: res.status, reason };
  }
  throw new Error(`merge failed for ${pr.repo}#${pr.number}: HTTP ${res.status} ${redactAndCap(text, 300)}`);
}

// ---- the merge queue (agent-ship item 9; issue 2011) --------------------------------------------------

/** `GET /repos/{repo}/rules/branches/{branch}`: whether a `merge_queue` rule
 *  protects the branch. Undefined when GitHub cannot be read or answers out of
 *  shape — the caller falls back to recognising the merge's 405. */
export async function branchHasMergeQueue(repo: string, branch: string): Promise<boolean | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/rules/branches/${encodeURIComponent(branch)}`, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => null)) as Array<{ type?: unknown }> | null;
  if (!Array.isArray(data) || data.some((rule) => !rule || typeof rule.type !== "string")) return undefined;
  return data.some((rule) => rule.type === "merge_queue");
}

/** One GraphQL call on the App token: the parsed `data`, or a throw naming the
 *  HTTP status; GraphQL-level errors come back on `errors` for the caller. */
async function graphql(
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data?: unknown; errors?: Array<{ message?: unknown }> }> {
  const token = await requireToken();
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: apiHeaders(token, true),
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`GraphQL failed: HTTP ${res.status} ${redactAndCap(text, 300)}`);
  try {
    return JSON.parse(text) as { data?: unknown; errors?: Array<{ message?: unknown }> };
  } catch {
    throw new Error(`GraphQL answered out of shape: ${redactAndCap(text, 300)}`);
  }
}

const prGraphqlArgs = (pr: { repo: string; number: number }) => {
  const [owner, name] = pr.repo.split("/");
  return { owner, name, number: pr.number };
};

export type EnqueueResult = { ok: true } | { ok: false; reason: string };

/** One exact-head enqueue. Only the native entry acknowledges the write;
 * errors or partial responses leave its outcome unknown to the durable caller. */
export async function enqueuePullRequest(
  pr: { repo: string; number: number },
  opts: { sha: string },
): Promise<EnqueueResult> {
  if (!/^[0-9a-f]{40}$/i.test(opts.sha)) throw new Error("enqueue requires an exact full head sha");
  const looked = await graphql(
    `
      query ($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            id
            headRefOid
          }
        }
      }
    `,
    prGraphqlArgs(pr),
  );
  const node = (looked.data as { repository?: { pullRequest?: { id?: unknown; headRefOid?: unknown } } } | undefined)
    ?.repository?.pullRequest;
  if (looked.errors !== undefined && (!Array.isArray(looked.errors) || looked.errors.length > 0))
    throw new Error(`enqueue lookup unavailable: ${firstGraphqlError(looked) ?? "invalid errors"}`);
  if (
    typeof node?.id !== "string" ||
    node.id.length === 0 ||
    typeof node.headRefOid !== "string" ||
    !/^[0-9a-f]{40}$/i.test(node.headRefOid)
  )
    throw new Error("enqueue lookup returned incomplete native identity");
  if (node.headRefOid.toLowerCase() !== opts.sha.toLowerCase())
    return { ok: false, reason: `${pr.repo}#${pr.number} no longer has the exact enqueue head` };
  const answer = await graphql(
    `
      mutation ($id: ID!, $sha: GitObjectID!) {
        enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $sha }) {
          mergeQueueEntry {
            id
            pullRequest {
              id
              headRefOid
            }
          }
        }
      }
    `,
    { id: node.id, sha: opts.sha },
  );
  const entry = (
    answer.data as
      | {
          enqueuePullRequest?: {
            mergeQueueEntry?: { id?: unknown; pullRequest?: { id?: unknown; headRefOid?: unknown } };
          };
        }
      | undefined
  )?.enqueuePullRequest?.mergeQueueEntry;
  if (
    (answer.errors !== undefined && (!Array.isArray(answer.errors) || answer.errors.length > 0)) ||
    typeof entry?.id !== "string" ||
    entry.id.length === 0 ||
    entry.pullRequest?.id !== node.id ||
    typeof entry.pullRequest.headRefOid !== "string" ||
    entry.pullRequest.headRefOid.toLowerCase() !== opts.sha.toLowerCase()
  )
    throw new Error(`enqueue outcome unverified: ${firstGraphqlError(answer) ?? "native entry unavailable"}`);
  return { ok: true };
}

function firstGraphqlError(answer: { errors?: Array<{ message?: unknown }> }): string | undefined {
  const msg = answer.errors?.find((e) => typeof e?.message === "string")?.message;
  return typeof msg === "string" ? redactAndCap(msg, 300) : answer.errors?.length ? "GraphQL refused" : undefined;
}

/** Where an open pull request stands with the base's merge queue: in it, or
 *  out of it — with the queue's own removal reason when the timeline carries a
 *  `RemovedFromMergeQueueEvent` (a failing check in the queue, a conflict). */
export type MergeQueueState =
  { queued: true; position?: number; headSha?: string } | { queued: false; reason?: string };

/** The pull request's `mergeQueueEntry` and the last removal's reason, over
 *  GraphQL. Undefined when GitHub cannot be read — the caller treats unknown
 *  as unanswered, never as removed. */
export async function fetchMergeQueueState(pr: { repo: string; number: number }): Promise<MergeQueueState | undefined> {
  let answer: Awaited<ReturnType<typeof graphql>>;
  try {
    answer = await graphql(
      `
        query ($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              mergeQueueEntry {
                headCommit {
                  oid
                }
                pullRequest {
                  headRefOid
                }
                position
              }
              timelineItems(last: 10, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) {
                nodes {
                  ... on RemovedFromMergeQueueEvent {
                    reason
                  }
                }
              }
            }
          }
        }
      `,
      prGraphqlArgs(pr),
    );
  } catch {
    return undefined;
  }
  const node = (
    answer.data as
      | {
          repository?: {
            pullRequest?: {
              mergeQueueEntry?: {
                position?: unknown;
                headCommit?: { oid?: unknown } | null;
                pullRequest?: { headRefOid?: unknown };
              } | null;
              timelineItems?: { nodes?: Array<{ reason?: unknown } | null> };
            } | null;
          };
        }
      | undefined
  )?.repository?.pullRequest;
  if (
    (answer.errors !== undefined && (!Array.isArray(answer.errors) || answer.errors.length > 0)) ||
    node === undefined ||
    node === null
  )
    return undefined;
  const entry = node.mergeQueueEntry;
  if (entry === undefined) return undefined;
  if (entry !== null) {
    if (typeof entry !== "object" || !Number.isSafeInteger(entry.position) || (entry.position as number) < 1)
      return undefined;
    const headSha = entry.headCommit?.oid;
    return {
      queued: true,
      position: entry.position as number,
      ...(typeof headSha === "string" && /^[0-9a-f]{40}$/i.test(headSha) && entry.pullRequest?.headRefOid === headSha
        ? { headSha }
        : {}),
    };
  }
  const reasons = (node.timelineItems?.nodes ?? []).filter(
    (n): n is { reason: string } => n !== null && typeof n?.reason === "string" && n.reason.length > 0,
  );
  const reason = reasons.at(-1)?.reason;
  return { queued: false, ...(reason !== undefined ? { reason: redactAndCap(reason, 300) } : {}) };
}

/** What the checks at a commit say: the runs still queued or in progress and
 *  the runs that ended in anything but success, skipped or neutral. */
export interface CommitChecks {
  total: number;
  pending: string[];
  failed: string[];
}

const GREEN_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

interface NativeCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion?: unknown;
  details_url?: unknown;
  check_suite?: { id?: unknown } | null;
  app?: { slug?: unknown } | null;
}
const CHECK_STATUSES = new Set(["queued", "in_progress", "completed", "waiting", "requested", "pending"]);
const CHECK_CONCLUSIONS = new Set([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "waiting",
  "pending",
  "startup_failure",
  "stale",
]);

/** Read every page the native endpoint exposes. Count changes, duplicate IDs
 * or foreign heads make the read unavailable, never an all-green prefix. */
async function readCommitCheckRuns(repo: string, sha: string): Promise<NativeCheckRun[] | undefined> {
  if (!githubRepo(repo) || !fullHead(sha)) return undefined;
  const token = await resolveGithubToken().catch(() => null);
  const out: NativeCheckRun[] = [];
  const ids = new Set<number>();
  let total: number | undefined;
  try {
    for (let page = 1; page <= 100; page++) {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
        {
          headers: apiHeaders(token),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!res.ok) return undefined;
      const data = (await res.json()) as { total_count?: unknown; check_runs?: unknown } | null;
      if (
        !data ||
        !Number.isSafeInteger(data.total_count) ||
        (data.total_count as number) < 0 ||
        !Array.isArray(data.check_runs)
      )
        return undefined;
      total ??= data.total_count as number;
      if (data.total_count !== total || data.check_runs.length !== Math.min(100, total - out.length)) return undefined;
      for (const run of data.check_runs as Array<Record<string, unknown>>) {
        if (
          !run ||
          typeof run !== "object" ||
          Array.isArray(run) ||
          !positiveNativeId(run.id) ||
          ids.has(run.id) ||
          typeof run.head_sha !== "string" ||
          run.head_sha.toLowerCase() !== sha.toLowerCase() ||
          typeof run.name !== "string" ||
          !run.name ||
          !CHECK_STATUSES.has(run.status as string) ||
          (run.status === "completed" && !CHECK_CONCLUSIONS.has(run.conclusion as string))
        )
          return undefined;
        ids.add(run.id);
        out.push(run as unknown as NativeCheckRun);
      }
      if (out.length === total) return /rel="next"/.test(res.headers.get("link") ?? "") ? undefined : out;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function fetchCommitChecks(repo: string, sha: string): Promise<CommitChecks | undefined> {
  const rows = await readCommitCheckRuns(repo, sha);
  if (!rows) return undefined;
  const out: CommitChecks = { total: rows.length, pending: [], failed: [] };
  for (const row of rows) {
    if (row.status !== "completed") out.pending.push(row.name);
    else if (!GREEN_CONCLUSIONS.has(row.conclusion as string)) out.failed.push(row.name);
  }
  return out;
}

/** Freeze a complete set of failed native check IDs before effect admission.
 * An Actions URL only locates a read: the native run's suite, head and repo
 * must independently bind the ID. No write is performed by this lookup. */
export async function fetchCheckRetryTargets(
  repo: string,
  sha: string,
  names: string[],
): Promise<CheckRetryTarget[] | undefined> {
  if (!Array.isArray(names) || names.length === 0 || names.some((name) => typeof name !== "string" || !name))
    return undefined;
  const rows = await readCommitCheckRuns(repo, sha);
  if (!rows) return undefined;
  const wanted = new Set(names);
  const found = new Set<string>();
  const targets: CheckRetryTarget[] = [];
  const actions = new Map<number, number>();
  const token = await resolveGithubToken().catch(() => null);
  try {
    for (const row of rows) {
      if (!wanted.has(row.name)) continue;
      if (row.status !== "completed" || GREEN_CONCLUSIONS.has(row.conclusion as string)) return undefined;
      found.add(row.name);
      const url = typeof row.details_url === "string" ? new URL(row.details_url) : undefined;
      if (url?.pathname.includes("/actions/runs/") || row.app?.slug === "github-actions") {
        const prefix = `/${repo}/actions/runs/`;
        if (
          !url ||
          url.origin !== "https://github.com" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !url.pathname.toLowerCase().startsWith(prefix.toLowerCase())
        )
          return undefined;
        const match = /^([1-9][0-9]*)(?:\/job\/[1-9][0-9]*)?\/?$/.exec(url.pathname.slice(prefix.length));
        const id = match ? Number(match[1]) : undefined;
        if (!positiveNativeId(id) || !positiveNativeId(row.check_suite?.id)) return undefined;
        const suiteId = row.check_suite.id;
        if (actions.has(id)) {
          if (actions.get(id) !== suiteId) return undefined;
          continue;
        }
        const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${id}`, {
          headers: apiHeaders(token),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status !== 200) return undefined;
        const run = (await res.json()) as {
          id?: unknown;
          head_sha?: unknown;
          check_suite_id?: unknown;
          repository?: { full_name?: unknown };
        } | null;
        if (
          run?.id !== id ||
          typeof run.head_sha !== "string" ||
          run.head_sha.toLowerCase() !== sha.toLowerCase() ||
          run.check_suite_id !== suiteId ||
          typeof run.repository?.full_name !== "string" ||
          run.repository.full_name.toLowerCase() !== repo.toLowerCase()
        )
          return undefined;
        actions.set(id, suiteId);
        targets.push({ operation: "actions_rerun", resourceId: id });
      } else {
        targets.push({ operation: "check_rerequest", resourceId: row.id });
      }
    }
  } catch {
    return undefined;
  }
  return found.size === wanted.size ? targets : undefined;
}

/** `GET /repos/{repo}/rules/branches/{branch}` → the contexts the branch's
 *  effective rules require green (`required_status_checks` rules, protection
 *  and rulesets alike), or undefined when GitHub cannot be read or the answer
 *  is not the route's. The round's checks step subtracts the reported runs
 *  from these to see a required check whose run does not exist yet — the
 *  repository's approve workflow at the verdict instant (agent-ship item 9,
 *  issue 2063). Never throws. */
export async function requiredCheckContexts(repo: string, branch: string): Promise<string[] | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/rules/branches/${encodeGithubRef(branch)}?per_page=100`, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!Array.isArray(data)) return undefined;
  const contexts: string[] = [];
  for (const rule of data as Array<{ type?: unknown; parameters?: { required_status_checks?: unknown } }>) {
    if (rule?.type !== "required_status_checks") continue;
    const rows = rule.parameters?.required_status_checks;
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Array<{ context?: unknown }>)
      if (typeof row?.context === "string" && row.context.length > 0) contexts.push(row.context);
  }
  return [...new Set(contexts)];
}

/** Git's autosquash prefixes: a commit that names itself with one is, by its
 *  own words, meant to be squashed before merge — a head carrying one is not
 *  in the ready state, and the merge-ready report says so (agent-ship item 9). */
const FIXUP_SUBJECT = /^(fixup|squash|amend)! /;

/** `GET /repos/{repo}/pulls/{n}/commits` (one page of 100) → the subjects of
 *  the commits that mark themselves as fix-ups (`fixup!`/`squash!`/`amend!`),
 *  or undefined when GitHub cannot be read or the answer is not the route's.
 *  An empty list is a positive fact: no commit on the head calls itself a
 *  fix-up. Never throws — the caller leaves an unknown fact out of its answer. */
export async function fixupCommitSubjects(pr: { repo: string; number: number }): Promise<string[] | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${pr.repo}/pulls/${pr.number}/commits?per_page=100`, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!Array.isArray(data)) return undefined;
  const subjects: string[] = [];
  for (const row of data as Array<{ commit?: { message?: unknown } }>) {
    const message = row?.commit?.message;
    if (typeof message !== "string") continue;
    const subject = message.split("\n", 1)[0];
    if (FIXUP_SUBJECT.test(subject)) subjects.push(subject);
  }
  return subjects;
}

/** `GET /repos/{repo}/commits/{sha}/check-runs` (one page of 100) → the check
 *  runs at the sha with their conclusions, URLs and output words — what the
 *  ship round's `checks` step classifies (record 0055) — or undefined when
 *  GitHub cannot be read or the answer is not the route's. Never throws. */
export async function fetchCheckRunDetails(repo: string, sha: string): Promise<CheckRunDetail[] | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100`, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => null)) as { check_runs?: unknown } | null;
  if (!data || !Array.isArray(data.check_runs)) return undefined;
  const details: CheckRunDetail[] = [];
  for (const run of data.check_runs as Array<{
    name?: unknown;
    status?: unknown;
    conclusion?: unknown;
    html_url?: unknown;
    details_url?: unknown;
    output?: { title?: unknown; summary?: unknown; text?: unknown };
  }>) {
    const output = [run.output?.title, run.output?.summary, run.output?.text]
      .filter((v): v is string => typeof v === "string")
      .join("\n")
      .slice(0, CHECK_OUTPUT_MAX);
    const url = typeof run.html_url === "string" ? run.html_url : undefined;
    const detailsUrl = typeof run.details_url === "string" ? run.details_url : undefined;
    details.push({
      name: typeof run.name === "string" ? run.name : "(unnamed)",
      status: typeof run.status === "string" ? run.status : "completed",
      ...(typeof run.conclusion === "string" ? { conclusion: run.conclusion } : {}),
      ...(url !== undefined ? { url } : detailsUrl !== undefined ? { url: detailsUrl } : {}),
      ...(output.length > 0 ? { output } : {}),
    });
  }
  return details;
}

/** How much of a check run's output the classifier reads: enough for the
 *  timeout line and the shard's test file names, bounded so a verbose
 *  reporter's whole log never rides an admin answer. */
const CHECK_OUTPUT_MAX = 4000;

/** `GET /repos/{repo}/pulls/{n}/files` (one page of 100) → the pull request's
 *  changed paths — what the flake rule's "never touch" is judged against — or
 *  undefined when GitHub cannot be read. Never throws. */
export async function pullRequestChangedPaths(pr: { repo: string; number: number }): Promise<string[] | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!Array.isArray(data)) return undefined;
  return (data as Array<{ filename?: unknown }>)
    .map((f) => f.filename)
    .filter((f): f is string => typeof f === "string");
}

/** One review on a pull request as the coordinator reads it back: who posted
 *  it, GitHub's state, the head it was pinned to and its body — enough to tell
 *  whether the bot's own verdict stands on the pull request at a given head. */
/** One open pull request as `GET /repos/{repo}/pulls?state=open` lists it —
 *  the sweep's raw listing (agent-ship.md item 20). The listing's
 *  `mergeable_state` is NOT here on purpose: the list endpoint never carries
 *  it, so the sweep reads each pull request's facts fresh
 *  (`fetchPullRequestFacts`) before deciding anything. */
export interface OpenPullRequestRow {
  number: number;
  /** Head branch name; absent when malformed. */
  headRef?: string;
  /** Base branch name; absent when malformed. */
  baseRef?: string;
  /** Head sha (40-hex) when well-formed. */
  headSha?: string;
  /** True only on a POSITIVE match of head repo == base repo (a fork's head
   *  is not the pipeline's to rebase). */
  sameRepoHead: boolean;
}

/** Every decision-record number already unavailable to a new admission:
 * records on origin/main plus records added by every open pull request. The
 * caller serializes the still-local interval before a newly admitted task has
 * an open pull request. Throws rather than allocating from an incomplete view. */
export async function fetchDecisionRecordClaims(repo: string): Promise<ReadonlySet<string>> {
  const token = await requireToken();
  const get = async (url: string, what: string): Promise<unknown> => {
    const res = await fetch(url, { headers: apiHeaders(token), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${what} could not be read: HTTP ${res.status} ${redactAndCap(text, 300)}`);
    }
    return res.json().catch(() => null);
  };
  const numbers = new Set<string>();
  const claim = (path: unknown) => {
    if (typeof path !== "string") return;
    const number = /^docs\/decisions\/(\d{4})-[^/]+\.md$/.exec(path)?.[1];
    if (number !== undefined) numbers.add(number);
  };

  const main = await get(
    `https://api.github.com/repos/${repo}/contents/docs/decisions?ref=main&per_page=1000`,
    `origin/main's decision records in ${repo}`,
  );
  if (!Array.isArray(main))
    throw new Error(`origin/main's decision records in ${repo} could not be read: malformed answer`);
  for (const row of main as Array<{ path?: unknown }>) claim(row.path);

  const pulls: number[] = [];
  for (let page = 1; ; page += 1) {
    const rows = await get(
      `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100&page=${page}`,
      `the open pull requests of ${repo}`,
    );
    if (!Array.isArray(rows)) throw new Error(`the open pull requests of ${repo} could not be read: malformed answer`);
    for (const row of rows as Array<{ number?: unknown }>)
      if (typeof row.number === "number" && Number.isInteger(row.number) && row.number > 0) pulls.push(row.number);
    if (rows.length < 100) break;
  }
  await Promise.all(
    pulls.map(async (number) => {
      for (let page = 1; ; page += 1) {
        const rows = await get(
          `https://api.github.com/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
          `the changed files of ${repo}#${number}`,
        );
        if (!Array.isArray(rows))
          throw new Error(`the changed files of ${repo}#${number} could not be read: malformed answer`);
        for (const row of rows as Array<{ filename?: unknown }>) claim(row.filename);
        if (rows.length < 100) break;
      }
    }),
  );
  return numbers;
}

/** Every open pull request of `repo`, oldest first as GitHub lists them (one
 *  page of 100 — the pipeline's open set is far smaller). Throws on missing
 *  credential or a non-2xx response, so the sweep's answer names the failure
 *  instead of sweeping an empty list. */
export async function listOpenPullRequests(repo: string): Promise<OpenPullRequestRow[]> {
  const token = await requireToken();
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`, {
    headers: apiHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `the open pull requests of ${repo} could not be listed: HTTP ${res.status} ${redactAndCap(text, 300)}`,
    );
  }
  const rows = (await res.json().catch(() => null)) as unknown;
  if (!Array.isArray(rows)) throw new Error(`the open pull requests of ${repo} could not be listed: malformed answer`);
  return rows.flatMap((r) => {
    const row = r as {
      number?: unknown;
      head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } };
      base?: { ref?: unknown };
    };
    if (typeof row.number !== "number") return [];
    const headRepo = typeof row.head?.repo?.full_name === "string" ? row.head.repo.full_name.toLowerCase() : undefined;
    return [
      {
        number: row.number,
        ...(typeof row.head?.ref === "string" && row.head.ref ? { headRef: row.head.ref } : {}),
        ...(typeof row.base?.ref === "string" && row.base.ref ? { baseRef: row.base.ref } : {}),
        ...(typeof row.head?.sha === "string" && /^[0-9a-f]{40}$/.test(row.head.sha) ? { headSha: row.head.sha } : {}),
        sameRepoHead: headRepo === repo.toLowerCase(),
      },
    ];
  });
}

/** The pull request's current title and body — what the sweep's anchor
 *  regeneration edits in place (`updatePullRequest` takes both). Undefined
 *  when GitHub cannot answer; never throws. */
export async function fetchPullRequestTitleBody(pr: {
  repo: string;
  number: number;
}): Promise<{ title: string; body: string } | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${pr.repo}/pulls/${pr.number}`, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => null)) as { title?: unknown; body?: unknown } | null;
  if (!data || typeof data.title !== "string") return undefined;
  return { title: data.title, body: typeof data.body === "string" ? data.body : "" };
}

function nextGithubPage(link: string | null): string | undefined {
  for (const entry of link?.split(",") ?? []) {
    const target = /<([^>]+)>/.exec(entry)?.[1];
    const relations = /(?:^|;)\s*rel="([^"]+)"/.exec(entry)?.[1]?.split(/\s+/) ?? [];
    if (target !== undefined && relations.includes("next")) return target;
  }
  return undefined;
}

function isGithubListPage(url: string, base: string): boolean {
  let candidate: URL;
  let requested: URL;
  try {
    candidate = new URL(url);
    requested = new URL(base);
  } catch {
    return false;
  }
  if (
    candidate.origin !== requested.origin ||
    candidate.username !== "" ||
    candidate.password !== "" ||
    candidate.hash !== ""
  )
    return false;
  if (candidate.pathname === requested.pathname) return true;

  const requestedParts = requested.pathname.split("/").filter(Boolean);
  const candidateParts = candidate.pathname.split("/").filter(Boolean);
  const resourcePath = requestedParts.slice(3);
  return (
    requestedParts.length >= 4 &&
    requestedParts[0] === "repos" &&
    candidateParts.length === resourcePath.length + 2 &&
    candidateParts[0] === "repositories" &&
    /^\d+$/.test(candidateParts[1] ?? "") &&
    candidateParts.slice(2).every((part, index) => part === resourcePath[index])
  );
}

/** Every page of one GitHub list endpoint. Link targets stay on GitHub and
 * identify the same resource by its repo-name or canonical repository-ID path;
 * a malformed or cyclic chain fails closed. */
async function fetchGithubListPages(base: string, token: string | null): Promise<unknown[] | undefined> {
  const rows: unknown[] = [];
  const seen = new Set<string>();
  let url: string | undefined = `${base}?per_page=100`;
  while (url !== undefined) {
    if (!isGithubListPage(url, base) || seen.has(url)) return undefined;
    seen.add(url);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: apiHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return undefined;
    }
    if (!res.ok) return undefined;
    const page = (await res.json().catch(() => null)) as unknown;
    if (!Array.isArray(page)) return undefined;
    rows.push(...page);
    url = nextGithubPage(res.headers.get("link"));
  }
  return rows;
}

export interface PullRequestReview {
  /** Immutable GitHub review identity; legacy or malformed rows carry none. */
  id?: number;
  author?: { login?: string; id?: number };
  state: string;
  commitId?: string;
  submittedAt?: string;
  body: string;
}

export interface PullRequestComment {
  id: number;
  author: { login: string; id?: number; type: string };
  createdAt: string;
  body: string;
}

/** Pull-request conversation comments (the issues API's shared thread), every
 * page included. The author type lets callers accept people and ignore bots. */
export async function fetchPullRequestComments(pr: {
  repo: string;
  number: number;
}): Promise<PullRequestComment[] | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  const base = `https://api.github.com/repos/${pr.repo}/issues/${pr.number}/comments`;
  const rows = await fetchGithubListPages(base, token);
  if (rows === undefined) return undefined;
  return rows.flatMap((raw) => {
    const row = raw as {
      id?: unknown;
      user?: { login?: unknown; id?: unknown; type?: unknown };
      created_at?: unknown;
      body?: unknown;
    };
    if (
      typeof row.id !== "number" ||
      typeof row.user?.login !== "string" ||
      typeof row.user.type !== "string" ||
      typeof row.created_at !== "string" ||
      typeof row.body !== "string"
    )
      return [];
    return [
      {
        id: row.id,
        author: {
          login: row.user.login,
          ...(typeof row.user.id === "number" ? { id: row.user.id } : {}),
          type: row.user.type,
        },
        createdAt: row.created_at,
        body: row.body,
      },
    ];
  });
}

/** GET /repos/{repo}/pulls/{n}/reviews (every page, oldest first as GitHub
 *  lists them) → the reviews, or undefined when a fetch fails or an answer is
 *  not a list. Never throws. */
export async function fetchPullRequestReviews(pr: {
  repo: string;
  number: number;
}): Promise<PullRequestReview[] | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  const base = `https://api.github.com/repos/${pr.repo}/pulls/${pr.number}/reviews`;
  const rows = await fetchGithubListPages(base, token);
  if (rows === undefined) return undefined;
  return rows.flatMap((r) => {
    const row = r as {
      id?: unknown;
      user?: { login?: unknown; id?: unknown };
      state?: unknown;
      commit_id?: unknown;
      submitted_at?: unknown;
      body?: unknown;
    };
    if (typeof row.state !== "string") return [];
    return [
      {
        ...(row.user && (typeof row.user.login === "string" || typeof row.user.id === "number")
          ? {
              author: {
                ...(typeof row.user.login === "string" ? { login: row.user.login } : {}),
                ...(typeof row.user.id === "number" ? { id: row.user.id } : {}),
              },
            }
          : {}),
        ...(typeof row.id === "number" && Number.isSafeInteger(row.id) && row.id > 0 ? { id: row.id } : {}),
        state: row.state,
        ...(typeof row.commit_id === "string" ? { commitId: row.commit_id } : {}),
        ...(typeof row.submitted_at === "string" ? { submittedAt: row.submitted_at } : {}),
        body: typeof row.body === "string" ? row.body : "",
      },
    ];
  });
}

// ---- the identity rewrite's Git Data reads and writes (record 0062) ----
// The compare read, the commit rebuild and the conditional ref move the identity
// rewrite (src/execution/identityRewrite.ts) runs before the bot opens or
// edits a pull request, plus the assignee pre-check and write the post-step
// runs after an open. Same REST-with-App-token conventions as the writes
// above, never a `gh` shell-out (AGENTS.md invariant 5).

/** One commit as the compare endpoint lists it, the fields the identity
 *  rewrite reads: the exact author and committer pairs, the author date the
 *  fingerprint keeps, the tree and parents a rebuild reuses. */
export interface ComparedCommit {
  sha: string;
  treeSha: string;
  parents: string[];
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string };
  message: string;
}

/** The paginated compare `base...head`: GitHub's own count beside the commits
 *  read. `commits` may be shorter than `totalCommits` when the caller's cap
 *  stopped the paging (the rewrite refuses over 300 anyway). */
export interface CompareResult {
  totalCommits: number;
  commits: ComparedCommit[];
}

/** How many compare pages are read before the rewrite's own >300 refusal
 *  makes more paging pointless (100 per page; the cap is 301+). */
const COMPARE_PER_PAGE = 100;
const COMPARE_MAX_PAGES = 3;

/**
 * GET /repos/{repo}/compare/{base}...{head}, paginated — the commits reachable
 * from `head` and not from `base`, with `total_commits` as GitHub counts them.
 * `"missing"` on a 404 (a branch GitHub has never heard of — an answer, not an
 * error: a new branch's start state is empty); `undefined` on any other
 * failure, which the rewrite treats as unreadable. Never throws.
 */
export async function compareRange(
  repo: string,
  base: string,
  head: string,
): Promise<CompareResult | "missing" | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  if (!token) return undefined;
  const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  const commits: ComparedCommit[] = [];
  let totalCommits = 0;
  for (let page = 1; page <= COMPARE_MAX_PAGES; page += 1) {
    let res: Response;
    try {
      res = await fetch(
        `https://api.github.com/repos/${repo}/compare/${range}?per_page=${COMPARE_PER_PAGE}&page=${page}`,
        { headers: apiHeaders(token), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
    } catch {
      return undefined;
    }
    if (res.status === 404) return "missing";
    if (!res.ok) return undefined;
    const data = (await res.json().catch(() => null)) as {
      total_commits?: unknown;
      commits?: unknown;
    } | null;
    if (!data || typeof data.total_commits !== "number" || !Array.isArray(data.commits)) return undefined;
    totalCommits = data.total_commits;
    for (const raw of data.commits) {
      const parsed = parseComparedCommit(raw);
      if (!parsed) return undefined;
      commits.push(parsed);
    }
    if (commits.length >= totalCommits || data.commits.length < COMPARE_PER_PAGE) break;
  }
  return { totalCommits, commits };
}

function parseComparedCommit(raw: unknown): ComparedCommit | undefined {
  const row = raw as {
    sha?: unknown;
    parents?: unknown;
    commit?: {
      message?: unknown;
      tree?: { sha?: unknown };
      author?: { name?: unknown; email?: unknown; date?: unknown };
      committer?: { name?: unknown; email?: unknown };
    };
  };
  const c = row.commit;
  if (
    typeof row.sha !== "string" ||
    !c ||
    typeof c.message !== "string" ||
    typeof c.tree?.sha !== "string" ||
    typeof c.author?.name !== "string" ||
    typeof c.author?.email !== "string" ||
    typeof c.author?.date !== "string" ||
    typeof c.committer?.name !== "string" ||
    typeof c.committer?.email !== "string" ||
    !Array.isArray(row.parents)
  )
    return undefined;
  const parents: string[] = [];
  for (const p of row.parents) {
    const sha = (p as { sha?: unknown }).sha;
    if (typeof sha !== "string") return undefined;
    parents.push(sha);
  }
  return {
    sha: row.sha,
    treeSha: c.tree.sha,
    parents,
    author: { name: c.author.name, email: c.author.email, date: c.author.date },
    committer: { name: c.committer.name, email: c.committer.email },
    message: c.message,
  };
}

/**
 * POST /repos/{repo}/git/commits — rebuild one commit with the same tree, the
 * rebuilt parents, a corrected author (with the original date) and the
 * committer sent EXPLICITLY (the API defaults the committer to the author it
 * is given). Returns the new sha; throws on any failure with the status and
 * body so the rewrite can name a ruleset refusal.
 */
export async function createCommit(
  repo: string,
  commit: {
    message: string;
    tree: string;
    parents: string[];
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string };
  },
): Promise<string> {
  const token = await requireToken();
  const res = await fetch(`https://api.github.com/repos/${repo}/git/commits`, {
    method: "POST",
    headers: apiHeaders(token, true),
    body: JSON.stringify(commit),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`commit rebuild failed: HTTP ${res.status} ${redactAndCap(text, 300)}`);
  }
  const data = (await res.json().catch(() => null)) as { sha?: unknown } | null;
  if (typeof data?.sha !== "string") throw new Error("commit rebuild answered without a sha");
  return data.sha;
}

/** Move a rewritten commit only if the ref still has the compare's tip. */
export async function forceMoveRef(repo: string, branch: string, sha: string, expectedSha: string): Promise<void> {
  const [owner, name] = repo.split("/");
  const looked = await graphql(
    `
      query ($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          id
        }
      }
    `,
    { owner, name },
  );
  const repositoryId = (looked.data as { repository?: { id?: unknown } } | undefined)?.repository?.id;
  if (typeof repositoryId !== "string")
    throw new Error(`ref move failed for ${branch}: ${firstGraphqlError(looked) ?? "repository id unavailable"}`);
  const moved = await graphql(
    `
      mutation ($repositoryId: ID!, $name: GitRefname!, $before: GitObjectID!, $after: GitObjectID!) {
        updateRefs(
          input: {
            repositoryId: $repositoryId
            refUpdates: [{ name: $name, beforeOid: $before, afterOid: $after, force: true }]
          }
        ) {
          clientMutationId
        }
      }
    `,
    { repositoryId, name: `refs/heads/${branch}`, before: expectedSha, after: sha },
  );
  if ((moved.data as { updateRefs?: unknown } | undefined)?.updateRefs == null || firstGraphqlError(moved))
    throw new Error(`ref move failed for ${branch}: ${firstGraphqlError(moved) ?? "update result unavailable"}`);
}

/** GET /repos/{repo}/pulls/{number} → the pull request's `head.sha` — the pin
 *  the post-step reads after an open or edit. Undefined on any failure. */
export async function pullRequestHead(repo: string, number: number): Promise<string | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  if (!token) return undefined;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => null)) as { head?: { sha?: unknown } } | null;
  return typeof data?.head?.sha === "string" ? data.head.sha : undefined;
}

/** GET /repos/{repo}/assignees/{login} — whether the login can be assigned:
 *  `true` on 204, `false` on 404 (skipped with one log line at the caller),
 *  `undefined` when GitHub could not be asked. Never throws. */
export async function isAssignable(repo: string, login: string): Promise<boolean | undefined> {
  const token = await resolveGithubToken().catch(() => null);
  if (!token) return undefined;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/assignees/${encodeURIComponent(login)}`, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (res.status === 204) return true;
  return res.status === 404 ? false : undefined;
}

/** POST /repos/{repo}/issues/{number}/assignees — add one assignee. Throws on
 *  a non-2xx so the caller can log honestly (the open itself already stands). */
export async function addAssignee(repo: string, number: number, login: string): Promise<void> {
  const token = await requireToken();
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/assignees`, {
    method: "POST",
    headers: apiHeaders(token, true),
    body: JSON.stringify({ assignees: [login] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`assignee add failed for ${login}: HTTP ${res.status} ${redactAndCap(text, 300)}`);
  }
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
