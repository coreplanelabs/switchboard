import {
  CI_TRIGGERS,
  coauthorsOf,
  type CiRunFact,
  type DeliveryFetch,
  type DeliveryRange,
  type DeliverySource,
  type LinkedIssueFact,
  type PullRequestFacts,
  type PushFact,
  type ReviewFact,
} from "../core/delivery.js";
import { mapLimit } from "../core/mapLimit.js";
import { redactAndCap } from "../core/redact.js";
import { resolveGithubToken, type GithubTokenScope } from "./githubApp.js";

// The GitHub read behind the delivery indicators (docs/reference/specs/delivery.md):
// the facts `buildDeliveryReport` needs, assembled from four REST reads per
// repository over the App's READ-scoped installation token — never a `gh`
// shell-out, never a clone (AGENTS.md invariant 5), and never a write.
//
//   GET /repos/{repo}/pulls?state=closed&sort=updated&direction=desc   the merged pull
//       requests in range: pages of 100 newest-touched first, until a page
//       carries a row last touched before the range began (a row's
//       `updated_at` is never before its `merged_at`, so nothing merged in
//       range can follow) or the page cap ends the read (`truncated`);
//   GET /repos/{repo}/issues/{n}/timeline     one pull request's reviews (each
//       verdict's author, state, head and body), its commits (with their
//       `Co-Authored-By:` trailers) and its force-pushes (with their actor);
//   GET /repos/{repo}/actions/runs?branch=…   the workflow runs on the head
//       branch — each run's head, trigger, conclusion and attempt, which is
//       where a retry shows (a check suite does not record one);
//   GET /repos/{repo}/issues/{n}              the board issue the body links, for
//       its creation time — the start of the unit's issue-to-merge clock.
//
// The parsers are pure and unit-tested against the API's recorded shapes; the
// class only fetches, pages and joins. A 404 on the issue or on Actions is an
// absent fact, not a failure; any other non-2xx throws with the status and a
// redacted, capped body so the page can answer 502 without a stack.

const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const DEFAULT_MAX_PULL_PAGES = 3;
const MAX_TIMELINE_PAGES = 3;
const DEFAULT_CONCURRENCY = 6;

export interface GithubDeliverySourceOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Credential resolver; defaults to the App installation token (read-scoped), else GH_TOKEN. */
  token?: (scope: GithubTokenScope) => Promise<string | null>;
  /** Listing pages of 100 read before the fetch is called truncated (default 3: the newest 300 closed pull requests). */
  maxPullPages?: number;
  /** Pull requests whose facts are read at once (default 6). */
  concurrency?: number;
}

/** One row of the closed-pulls listing, as the report needs it. */
export interface PullListItem {
  number: number;
  title: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  /** null: closed without merging. */
  mergedAt: string | null;
  headRef: string;
  headSha: string;
  body: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The listing rows that carry what the report needs; anything else is dropped. */
export function parsePullListPage(raw: unknown): PullListItem[] {
  if (!Array.isArray(raw)) return [];
  const out: PullListItem[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const number = num(r.number);
    const createdAt = str(r.created_at);
    const updatedAt = str(r.updated_at);
    if (number === undefined || createdAt === undefined || updatedAt === undefined) continue;
    const head = (r.head ?? {}) as Record<string, unknown>;
    const user = (r.user ?? {}) as Record<string, unknown>;
    out.push({
      number,
      title: str(r.title) ?? "",
      author: str(user.login) ?? "",
      createdAt,
      updatedAt,
      mergedAt: str(r.merged_at) ?? null,
      headRef: str(head.ref) ?? "",
      headSha: str(head.sha) ?? "",
      body: typeof r.body === "string" ? r.body : "",
    });
  }
  return out;
}

const dayStartMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const DAY_MS = 86_400_000;

/** The rows merged inside the range, and whether a row last touched before the
 *  range began was seen — after which no later page can hold a merge in range. */
export function selectMerged(
  items: readonly PullListItem[],
  range: DeliveryRange,
): { merged: PullListItem[]; olderSeen: boolean } {
  const since = dayStartMs(range.since);
  const until = dayStartMs(range.until) + DAY_MS;
  const merged = items.filter((i) => {
    if (i.mergedAt === null) return false;
    const t = Date.parse(i.mergedAt);
    return t >= since && t < until;
  });
  return { merged, olderSeen: items.some((i) => Date.parse(i.updatedAt) < since) };
}

const REVIEW_STATES: ReadonlySet<ReviewFact["state"]> = new Set([
  "approved",
  "changes_requested",
  "commented",
  "dismissed",
  "pending",
]);

/** The reviews and pushes a pull request's timeline records, each in time order. */
export function parseTimeline(raw: unknown): { reviews: ReviewFact[]; pushes: PushFact[] } {
  if (!Array.isArray(raw)) return { reviews: [], pushes: [] };
  const reviews: ReviewFact[] = [];
  const commits: PushFact[] = [];
  const forces: Array<{ actor: string; at: string }> = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const ev = e as Record<string, unknown>;
    switch (ev.event) {
      case "reviewed": {
        const author = str((ev.user as Record<string, unknown> | null)?.login);
        const submittedAt = str(ev.submitted_at);
        if (author === undefined || submittedAt === undefined) continue;
        const state = String(ev.state ?? "").toLowerCase() as ReviewFact["state"];
        reviews.push({
          author,
          state: REVIEW_STATES.has(state) ? state : "commented",
          submittedAt,
          body: typeof ev.body === "string" ? ev.body : "",
          ...(str(ev.commit_id) ? { headSha: str(ev.commit_id) } : {}),
        });
        break;
      }
      case "committed": {
        const committer = (ev.committer ?? {}) as Record<string, unknown>;
        const author = (ev.author ?? {}) as Record<string, unknown>;
        const at = str(committer.date) ?? str(author.date);
        if (at === undefined) continue;
        commits.push({
          actor: str(committer.name) ?? str(author.name) ?? "",
          at,
          kind: "commit",
          coauthors: coauthorsOf(typeof ev.message === "string" ? ev.message : ""),
        });
        break;
      }
      case "head_ref_force_pushed": {
        const actor = str((ev.actor as Record<string, unknown> | null)?.login);
        const at = str(ev.created_at);
        if (actor === undefined || at === undefined) continue;
        forces.push({ actor, at });
        break;
      }
      default:
        break;
    }
  }
  // A force-push replaced the branch with the commits the timeline now lists —
  // GitHub keeps no record of what it replaced — so their co-authors are its.
  const coauthors = [...new Set(commits.flatMap((c) => c.coauthors))];
  const pushes: PushFact[] = [...commits, ...forces.map((f) => ({ ...f, kind: "force" as const, coauthors }))];
  const byTime =
    <T extends { at: string } | { submittedAt: string }>(key: (x: T) => string) =>
    (a: T, b: T) =>
      Date.parse(key(a)) - Date.parse(key(b));
  return {
    reviews: reviews.sort(byTime((r) => r.submittedAt)),
    pushes: pushes.sort(byTime((p) => p.at)),
  };
}

/** The workflow runs of a branch as CI facts; a run without a head is dropped. */
export function parseWorkflowRuns(raw: unknown): CiRunFact[] {
  const runs = (raw as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(runs)) return [];
  const out: CiRunFact[] = [];
  for (const r of runs) {
    if (!r || typeof r !== "object") continue;
    const run = r as Record<string, unknown>;
    const headSha = str(run.head_sha);
    const createdAt = str(run.created_at);
    if (headSha === undefined || createdAt === undefined) continue;
    out.push({
      ...(str(run.name) ? { name: str(run.name) } : {}),
      headSha,
      trigger: str(run.event) ?? "",
      conclusion: str(run.conclusion) ?? null,
      attempt: num(run.run_attempt) ?? 1,
      createdAt,
    });
  }
  return out;
}

/** The head CI first ran on: the earliest pull-request-triggered run's head
 *  (the same trigger set the indicator judges by), else the earliest review's
 *  head, else the pull request's current head. */
export function firstHeadOf(ci: readonly CiRunFact[], reviews: readonly ReviewFact[], headSha: string): string {
  const earliest = <T>(items: readonly T[], at: (x: T) => string): T | undefined =>
    [...items].sort((a, b) => Date.parse(at(a)) - Date.parse(at(b)))[0];
  const run = earliest(
    ci.filter((r) => CI_TRIGGERS.has(r.trigger)),
    (r) => r.createdAt,
  );
  if (run) return run.headSha;
  const review = earliest(
    reviews.filter((r) => r.headSha !== undefined),
    (r) => r.submittedAt,
  );
  return review?.headSha ?? headSha;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `#<n>`, or the issue's URL in the report's OWN repository. Another
 *  repository's issue URL is not a reference: the issue is read from the
 *  report's repository, where the same number is some other issue. */
const issueRef = (repo: string): string =>
  String.raw`(?:#|https?:\/\/github\.com\/${escapeRegExp(repo)}\/issues\/)(\d+)\b`;

/** The board issue a pull request body links as its unit: a closing keyword
 *  first (`Closes #<n>`, `fixes <issue URL>`, `Resolved: #<n>`), then a `board
 *  item` reference (`board item [#<n>](…)` / `board item #<n>` — how a plan
 *  unit's pull request names its issue). A bare mention is not a link. */
export function linkedIssueNumber(body: string, repo: string): number | undefined {
  const ref = issueRef(repo);
  const closing = new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+${ref}`, "i");
  const boardItem = new RegExp(String.raw`\bboard item\b\W{0,3}${ref}`, "i");
  const m = closing.exec(body) ?? boardItem.exec(body);
  return m ? Number(m[1]) : undefined;
}

/** An issue's linkable facts; a pull request served at the issues route is not one. */
export function parseIssue(raw: unknown): LinkedIssueFact | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.pull_request !== undefined) return undefined;
  const number = num(r.number);
  const createdAt = str(r.created_at);
  if (number === undefined || createdAt === undefined) return undefined;
  return { number, ...(str(r.title) ? { title: str(r.title) } : {}), createdAt };
}

export class GithubDeliverySource implements DeliverySource {
  private readonly fetchImpl: typeof fetch;
  private readonly token: (scope: GithubTokenScope) => Promise<string | null>;
  private readonly maxPullPages: number;
  private readonly concurrency: number;

  constructor(opts: GithubDeliverySourceOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.token = opts.token ?? ((scope) => resolveGithubToken(scope));
    this.maxPullPages = Math.max(1, opts.maxPullPages ?? DEFAULT_MAX_PULL_PAGES);
    this.concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  }

  async fetchPullRequests(repo: string, range: DeliveryRange): Promise<DeliveryFetch> {
    const token = await this.token("read");
    if (!token)
      throw new Error(
        "no GitHub credential available to read the pull requests (configure the GitHub App or GH_TOKEN)",
      );
    const headers = {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "switchboard",
    };
    const get = async (route: string, path: string): Promise<Response> => {
      const res = await this.fetchImpl(`https://api.github.com${path}`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => "");
        let detail = redactAndCap(text, 300);
        try {
          const j = JSON.parse(text) as { message?: unknown };
          if (typeof j.message === "string") detail = redactAndCap(j.message, 300);
        } catch {
          /* keep the raw slice */
        }
        throw new Error(`GitHub GET ${route} failed: HTTP ${res.status} ${detail}`.trim());
      }
      return res;
    };
    const json = async (res: Response): Promise<unknown> => (res.status === 404 ? undefined : res.json());

    // 1. The merged pull requests in range, newest-touched first.
    const merged: PullListItem[] = [];
    let truncated = false;
    for (let page = 1; ; page++) {
      const res = await get(
        "pulls",
        `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`,
      );
      const items = parsePullListPage(await json(res));
      const selected = selectMerged(items, range);
      merged.push(...selected.merged);
      if (selected.olderSeen || items.length < PAGE_SIZE) break;
      if (page >= this.maxPullPages) {
        truncated = true;
        break;
      }
    }

    // 2. Each pull request's facts, a few at a time; issues read once each.
    const issues = new Map<number, Promise<LinkedIssueFact | undefined>>();
    const issueOf = (n: number): Promise<LinkedIssueFact | undefined> => {
      let p = issues.get(n);
      if (!p) {
        p = get("issue", `/repos/${repo}/issues/${n}`).then(async (res) => parseIssue(await json(res)));
        issues.set(n, p);
      }
      return p;
    };
    const prs = await mapLimit(merged, this.concurrency, async (item): Promise<PullRequestFacts> => {
      const timeline: unknown[] = [];
      for (let page = 1; page <= MAX_TIMELINE_PAGES; page++) {
        const res = await get(
          `timeline for ${item.number}`,
          `/repos/${repo}/issues/${item.number}/timeline?per_page=${PAGE_SIZE}&page=${page}`,
        );
        const events = await json(res);
        if (!Array.isArray(events)) break;
        timeline.push(...events);
        if (events.length < PAGE_SIZE) break;
      }
      const [runsBody, issueNumber] = [
        item.headRef === ""
          ? undefined
          : await json(
              await get(
                `workflow runs for ${item.number}`,
                `/repos/${repo}/actions/runs?branch=${encodeURIComponent(item.headRef)}&per_page=${PAGE_SIZE}`,
              ),
            ),
        linkedIssueNumber(item.body, repo),
      ];
      const { reviews, pushes } = parseTimeline(timeline);
      const ci = parseWorkflowRuns(runsBody);
      const issue = issueNumber === undefined ? undefined : await issueOf(issueNumber);
      return {
        number: item.number,
        title: item.title,
        author: item.author,
        createdAt: item.createdAt,
        mergedAt: item.mergedAt as string,
        firstHeadSha: firstHeadOf(ci, reviews, item.headSha),
        ci,
        reviews,
        pushes,
        ...(issue ? { issue } : {}),
      };
    });
    return { prs, truncated };
  }
}
