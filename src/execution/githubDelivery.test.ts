import { describe, expect, it } from "vitest";
import {
  firstHeadOf,
  GithubDeliverySource,
  linkedIssueNumber,
  parseIssue,
  parsePullListPage,
  parseTimeline,
  parseWorkflowRuns,
  selectMerged,
} from "./githubDelivery.js";

// The GitHub read behind the delivery indicators, against the API's own shapes
// as recorded from one pull request's listing row, timeline and workflow runs
// (names replaced with the fixture's: `alice`, `acme-review[bot]`, `acme/api`).
// The parsers are pure; the source is driven with an injected fetch that
// answers those recorded pages by URL, and nothing here reaches the network.

const REPO = "acme/api";
const HEAD = "c3bfbac617a8035845804b52a3212c20a93dec6a";
const FIRST_HEAD = "28837ecbdc07dd578743919c3a071dcd3756a47a";
const BRANCH = "trunk/durable-mutex";
const TRAILER = "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>";
/** An issue reference as a body spells it — built at runtime, so the fixture carries no literal tracker imprint. */
const ref = (n: number): string => `#${n}`;

/** `GET /repos/{repo}/pulls?state=closed` — one merged row, one closed-unmerged row, one merged before the range. */
const PULLS_PAGE = [
  {
    number: 917,
    title: "feat(resident): the mirror mutex is a durable lease",
    state: "closed",
    created_at: "2026-09-10T23:59:09Z",
    updated_at: "2026-09-11T16:10:06Z",
    merged_at: "2026-09-11T00:18:40Z",
    closed_at: "2026-09-11T00:18:40Z",
    user: { login: "alice", type: "User" },
    head: { ref: BRANCH, sha: HEAD },
    base: { ref: "main" },
    body: `The mirror mutex becomes a durable lease. Unit three of the [program plan](https://github.com/acme/api/blob/main/docs/plans/program.md), board item [${ref(825)}](https://github.com/acme/api/issues/825).\n\n## What & why\n\nRecord 0029 moves the cycles onto Workflows.`,
    html_url: "https://github.com/acme/api/pull/917",
  },
  {
    number: 912,
    title: "chore: an experiment that was closed unmerged",
    state: "closed",
    created_at: "2026-09-10T20:00:00Z",
    updated_at: "2026-09-11T10:00:00Z",
    merged_at: null,
    closed_at: "2026-09-11T10:00:00Z",
    user: { login: "alice", type: "User" },
    head: { ref: "chore/experiment", sha: "1111111111111111111111111111111111111111" },
    base: { ref: "main" },
    body: null,
    html_url: "https://github.com/acme/api/pull/912",
  },
  {
    number: 800,
    title: "feat: merged the week before",
    state: "closed",
    created_at: "2026-08-30T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    merged_at: "2026-09-01T09:00:00Z",
    closed_at: "2026-09-01T09:00:00Z",
    user: { login: "acme-coding[bot]", type: "Bot" },
    head: { ref: "feat/older", sha: "2222222222222222222222222222222222222222" },
    base: { ref: "main" },
    body: `Closes ${ref(700)}.`,
    html_url: "https://github.com/acme/api/pull/800",
  },
];

/** `GET /repos/{repo}/issues/917/timeline` — the events the parser reads, in the API's order. */
const TIMELINE = [
  {
    event: "reviewed",
    user: { login: "acme-review[bot]" },
    state: "commented",
    submitted_at: "2026-09-11T00:05:15Z",
    commit_id: FIRST_HEAD,
    body: "Changes requested: the resident invalidates its own live leases.\n- [blocking] F1 worker.ts:1453 — Incarnation re-minted on every state transition",
  },
  {
    event: "cross-referenced",
    actor: { login: "alice" },
    created_at: "2026-09-11T00:09:46Z",
    source: { type: "issue", issue: { number: 919 } },
  },
  {
    event: "committed",
    sha: HEAD,
    message: `feat(resident): the mirror mutex is a durable lease\n\n${TRAILER}`,
    author: { name: "Alice Example", email: "alice@example.test", date: "2026-09-10T07:10:01Z" },
    committer: { name: "Alice Example", email: "alice@example.test", date: "2026-09-11T00:13:23Z" },
  },
  { event: "head_ref_force_pushed", actor: { login: "alice" }, created_at: "2026-09-11T00:13:41Z", commit_id: HEAD },
  { event: "commented", actor: { login: "alice" }, created_at: "2026-09-11T00:16:35Z" },
  {
    event: "reviewed",
    user: { login: "acme-review[bot]" },
    state: "commented",
    submitted_at: "2026-09-11T00:17:46Z",
    commit_id: HEAD,
    body: "LGTM: All three prior findings verified fixed at head; no new issues.",
  },
  {
    event: "reviewed",
    user: { login: "github-actions[bot]" },
    state: "approved",
    submitted_at: "2026-09-11T00:18:06Z",
    commit_id: HEAD,
    body: "Auto-approved: acme-review[bot] reviewed this PR and posted an LGTM verdict.",
  },
  {
    event: "merged",
    actor: { login: "alice" },
    created_at: "2026-09-11T00:18:40Z",
    commit_id: "4ee0c66e4f03bb93dbf9aaf2a26f73221f1b9287",
  },
  // Malformed rows the API would never send, kept out by shape rather than by luck.
  { event: "reviewed", user: null, state: "commented", submitted_at: "2026-09-11T00:19:00Z", body: "no author" },
  { event: "committed", sha: "3333333333333333333333333333333333333333", message: "no committer date", committer: {} },
  { event: "head_ref_force_pushed", created_at: "2026-09-11T00:20:00Z" },
];

/** `GET /repos/{repo}/actions/runs?branch=…` — the runs on both heads, newest first. */
const RUNS_PAGE = {
  total_count: 9,
  workflow_runs: [
    {
      id: 1,
      name: "Auto-approve review LGTM",
      head_sha: HEAD,
      head_branch: BRANCH,
      event: "pull_request_review",
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
      created_at: "2026-09-11T00:17:49Z",
    },
    {
      id: 2,
      name: "pr-title",
      head_sha: HEAD,
      head_branch: BRANCH,
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
      created_at: "2026-09-11T00:13:45Z",
    },
    {
      id: 3,
      name: "ci",
      head_sha: HEAD,
      head_branch: BRANCH,
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
      created_at: "2026-09-11T00:13:45Z",
    },
    {
      id: 4,
      name: "Auto-approve review LGTM",
      head_sha: FIRST_HEAD,
      head_branch: BRANCH,
      event: "pull_request_review",
      status: "completed",
      conclusion: "skipped",
      run_attempt: 1,
      created_at: "2026-09-11T00:05:19Z",
    },
    {
      id: 5,
      name: "pr-title",
      head_sha: FIRST_HEAD,
      head_branch: BRANCH,
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
      created_at: "2026-09-10T23:59:14Z",
    },
    {
      id: 6,
      name: "ci",
      head_sha: FIRST_HEAD,
      head_branch: BRANCH,
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      run_attempt: 2,
      created_at: "2026-09-10T23:59:14Z",
    },
    {
      id: 7,
      name: "codeql",
      head_sha: FIRST_HEAD,
      head_branch: BRANCH,
      event: "pull_request",
      status: "in_progress",
      conclusion: null,
      run_attempt: 1,
      created_at: "2026-09-10T23:59:14Z",
    },
    {
      id: 8,
      name: "broken",
      head_branch: BRANCH,
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
      created_at: "2026-09-10T23:59:14Z",
    },
  ],
};

const ISSUE_825 = {
  number: 825,
  title: "The durable mutex and idempotent step methods",
  state: "closed",
  created_at: "2026-09-10T03:00:12Z",
  user: { login: "alice" },
  body: "…",
};

const RANGE = { since: "2026-09-07T00:00:00Z".slice(0, 10), until: "2026-09-13T00:00:00Z".slice(0, 10), weeks: 1 };

describe("parsePullListPage / selectMerged", () => {
  it("maps a listing row to the facts the report needs and keeps the body for the issue link; a row without a number or dates is dropped", () => {
    const items = parsePullListPage([...PULLS_PAGE, { number: "x" }, { title: "no number" }, null]);
    expect(items.map((i) => i.number)).toEqual([917, 912, 800]);
    expect(items[0]).toMatchObject({
      number: 917,
      title: "feat(resident): the mirror mutex is a durable lease",
      author: "alice",
      createdAt: "2026-09-10T23:59:09Z",
      updatedAt: "2026-09-11T16:10:06Z",
      mergedAt: "2026-09-11T00:18:40Z",
      headRef: BRANCH,
      headSha: HEAD,
    });
    expect(items[0].body).toContain("board item");
    expect(items[1].mergedAt).toBeNull();
    expect(items[1].body).toBe("");
  });

  it("keeps the rows merged inside the range, and says whether the page reached rows older than the range", () => {
    const items = parsePullListPage(PULLS_PAGE);
    const { merged, olderSeen } = selectMerged(items, RANGE);
    expect(merged.map((m) => m.number)).toEqual([917]);
    // Row 800 was last touched before the range began: nothing merged in range can follow it.
    expect(olderSeen).toBe(true);
    expect(selectMerged(items.slice(0, 2), RANGE)).toEqual({ merged: [items[0]], olderSeen: false });
    // Merged on the range's last day still counts; the day after does not.
    const last = { ...items[0], number: 1, mergedAt: "2026-09-13T23:59:59Z" };
    const after = { ...items[0], number: 2, mergedAt: "2026-09-14T00:00:00Z" };
    expect(selectMerged([last, after], RANGE).merged.map((m) => m.number)).toEqual([1]);
  });
});

describe("parseTimeline", () => {
  it("reads every review as a fact — author, state, time, head, body — and every push: a commit with its co-authors, a force-push by its actor", () => {
    const { reviews, pushes } = parseTimeline(TIMELINE);
    expect(reviews).toEqual([
      {
        author: "acme-review[bot]",
        state: "commented",
        submittedAt: "2026-09-11T00:05:15Z",
        headSha: FIRST_HEAD,
        body: expect.stringContaining("[blocking] F1"),
      },
      {
        author: "acme-review[bot]",
        state: "commented",
        submittedAt: "2026-09-11T00:17:46Z",
        headSha: HEAD,
        body: expect.stringContaining("LGTM"),
      },
      {
        author: "github-actions[bot]",
        state: "approved",
        submittedAt: "2026-09-11T00:18:06Z",
        headSha: HEAD,
        body: expect.stringContaining("Auto-approved"),
      },
    ]);
    expect(pushes).toEqual([
      {
        actor: "Alice Example",
        at: "2026-09-11T00:13:23Z",
        kind: "commit",
        coauthors: ["Claude Fable 5.1 <noreply@anthropic.com>"],
      },
      // The force-push replaced the branch with the commits the timeline lists: their co-authors are its.
      {
        actor: "alice",
        at: "2026-09-11T00:13:41Z",
        kind: "force",
        coauthors: ["Claude Fable 5.1 <noreply@anthropic.com>"],
      },
    ]);
  });

  it("an unknown review state is kept as `commented`; a review without a body has an empty one; nothing else in the timeline is a fact", () => {
    const { reviews, pushes } = parseTimeline([
      { event: "reviewed", user: { login: "x" }, state: "weird", submitted_at: "2026-09-11T00:00:00Z" },
      { event: "labeled", actor: { login: "x" }, created_at: "2026-09-11T00:00:00Z" },
    ]);
    expect(reviews).toEqual([{ author: "x", state: "commented", submittedAt: "2026-09-11T00:00:00Z", body: "" }]);
    expect(pushes).toEqual([]);
    expect(parseTimeline("not a list" as never)).toEqual({ reviews: [], pushes: [] });
  });
});

describe("parseWorkflowRuns", () => {
  it("maps each run to its head, trigger, conclusion and attempt; a run without a head sha is dropped; a body without runs is empty", () => {
    const runs = parseWorkflowRuns(RUNS_PAGE);
    expect(runs).toHaveLength(7);
    expect(runs[5]).toEqual({
      name: "ci",
      headSha: FIRST_HEAD,
      trigger: "pull_request",
      conclusion: "success",
      attempt: 2,
      createdAt: "2026-09-10T23:59:14Z",
    });
    expect(runs[6].conclusion).toBeNull();
    expect(parseWorkflowRuns({})).toEqual([]);
    expect(parseWorkflowRuns(null)).toEqual([]);
  });
});

describe("firstHeadOf", () => {
  it("is the head the earliest pull_request run ran on; without CI, the earliest review's head; without either, the current head", () => {
    const ci = parseWorkflowRuns(RUNS_PAGE);
    const { reviews } = parseTimeline(TIMELINE);
    expect(firstHeadOf(ci, reviews, HEAD)).toBe(FIRST_HEAD);
    // A review-triggered run on the newest head is not CI on a head.
    expect(firstHeadOf([ci[0]], reviews, HEAD)).toBe(FIRST_HEAD);
    expect(firstHeadOf([], reviews, HEAD)).toBe(FIRST_HEAD);
    expect(firstHeadOf([], [], HEAD)).toBe(HEAD);
  });
});

describe("linkedIssueNumber", () => {
  it("reads a closing keyword, then a `board item` reference, as a number or a link; a bare mention or the board's parent is not a unit", () => {
    expect(linkedIssueNumber(`Closes ${ref(12)} and moves on.`, REPO)).toBe(12);
    expect(linkedIssueNumber("This fixes https://github.com/acme/api/issues/9 for good", REPO)).toBe(9);
    expect(linkedIssueNumber("Resolved: #7 — see below", REPO)).toBe(7);
    expect(linkedIssueNumber(String(PULLS_PAGE[0].body), REPO)).toBe(825);
    expect(linkedIssueNumber(`Unit four, board item ${ref(826)}. Docs only.`, REPO)).toBe(826);
    expect(linkedIssueNumber(`Fixes #3; board item ${ref(826)}`, REPO)).toBe(3);
    expect(
      linkedIssueNumber(
        `The program ([plan](https://x/plan.md), board [${ref(821)}](https://github.com/acme/api/issues/821)) moved.`,
        REPO,
      ),
    ).toBeUndefined();
    expect(linkedIssueNumber(`As discussed in ${ref(44)}, nothing here closes it.`, REPO)).toBeUndefined();
    expect(linkedIssueNumber("", REPO)).toBeUndefined();
    // Another repository's issue is not this repository's unit, whatever its number.
    expect(linkedIssueNumber("Closes https://github.com/acme/web/issues/12 too", REPO)).toBeUndefined();
    expect(
      linkedIssueNumber("Fixes https://github.com/acme/api/issues/12#issuecomment-1", "acme/api.docs"),
    ).toBeUndefined();
  });
});

describe("parseIssue", () => {
  it("is the issue's number, title and creation; a pull request answering at the issues route is not an issue", () => {
    expect(parseIssue(ISSUE_825)).toEqual({
      number: 825,
      title: "The durable mutex and idempotent step methods",
      createdAt: "2026-09-10T03:00:12Z",
    });
    expect(parseIssue({ ...ISSUE_825, pull_request: { url: "…" } })).toBeUndefined();
    expect(parseIssue({ number: 1 })).toBeUndefined();
    expect(parseIssue(null)).toBeUndefined();
  });
});

// ---- the source over an injected fetch ------------------------------------------------------

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeGithub(
  routes: Record<string, unknown | ((url: URL) => Response)>,
  calls: Call[] = [],
): { fetch: typeof fetch; calls: Call[] } {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.pathname + url.search, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
    const key = Object.keys(routes).find((k) => url.pathname + url.search === k || url.pathname === k);
    if (key === undefined) return new Response("not found", { status: 404 });
    const value = routes[key];
    if (typeof value === "function") return (value as (u: URL) => Response)(url);
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const ROUTES = {
  "/repos/acme/api/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1": PULLS_PAGE,
  "/repos/acme/api/issues/917/timeline?per_page=100&page=1": TIMELINE,
  [`/repos/acme/api/actions/runs?branch=${encodeURIComponent(BRANCH)}&per_page=100`]: RUNS_PAGE,
  "/repos/acme/api/issues/825": ISSUE_825,
};

describe("GithubDeliverySource", () => {
  it("assembles one merged pull request's facts from the listing, its timeline, its branch's workflow runs and its linked issue — read-scoped, one page since the listing reached older rows", async () => {
    const gh = fakeGithub(ROUTES);
    const source = new GithubDeliverySource({ fetch: gh.fetch, token: async (scope) => `tok-${scope}` });
    const { prs, truncated, completeFrom } = await source.fetchPullRequests(REPO, RANGE);
    expect(truncated).toBe(false);
    // A complete read is complete from the range's start.
    expect(completeFrom).toBe(`${RANGE.since}T00:00:00Z`);
    expect(prs).toHaveLength(1);
    const pr = prs[0];
    expect(pr).toMatchObject({
      number: 917,
      author: "alice",
      createdAt: "2026-09-10T23:59:09Z",
      mergedAt: "2026-09-11T00:18:40Z",
      firstHeadSha: FIRST_HEAD,
      issue: { number: 825, title: "The durable mutex and idempotent step methods", createdAt: "2026-09-10T03:00:12Z" },
    });
    expect(pr.reviews).toHaveLength(3);
    expect(pr.pushes).toHaveLength(2);
    expect(pr.ci).toHaveLength(7);
    // Every call carried the read token and nothing more; the listing stopped at page one.
    expect(gh.calls.map((c) => c.url).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const c of gh.calls) {
      expect(c.headers.authorization).toBe("Bearer tok-read");
      expect(c.headers.accept).toBe("application/vnd.github+json");
    }
  });

  it("reads more listing pages while every row is still in range, and calls the fetch truncated when the page cap ends it first", async () => {
    const inRange = (n: number) => ({ ...PULLS_PAGE[0], number: n, head: { ref: `b${n}`, sha: HEAD }, body: "" });
    const fullPage = Array.from({ length: 100 }, (_, i) => inRange(1000 + i));
    const routes: Record<string, unknown> = {
      "/repos/acme/api/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1": fullPage,
      "/repos/acme/api/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=2": fullPage.map((p) => ({
        ...p,
        number: p.number + 100,
      })),
      "/repos/acme/api/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=3": [PULLS_PAGE[2]],
    };
    for (const n of [...fullPage.map((p) => p.number), ...fullPage.map((p) => p.number + 100)]) {
      routes[`/repos/acme/api/issues/${n}/timeline?per_page=100&page=1`] = [];
    }
    routes["/repos/acme/api/actions/runs"] = { workflow_runs: [] };
    const gh = fakeGithub(routes);
    const source = new GithubDeliverySource({
      fetch: gh.fetch,
      token: async () => "t",
      maxPullPages: 2,
      concurrency: 50,
    });
    const cut = await source.fetchPullRequests(REPO, RANGE);
    expect(cut.prs).toHaveLength(200);
    expect(cut.truncated).toBe(true);
    // A capped read is complete only from the oldest update the listing reached: every pull
    // request merged after that instant was updated after it, so it is among the rows read.
    expect(cut.completeFrom).toBe(PULLS_PAGE[0].updated_at);
    // With room for the third page the listing reaches the older row and is complete.
    const whole = new GithubDeliverySource({
      fetch: gh.fetch,
      token: async () => "t",
      maxPullPages: 3,
      concurrency: 50,
    });
    const all = await whole.fetchPullRequests(REPO, RANGE);
    expect(all.prs).toHaveLength(200);
    expect(all.truncated).toBe(false);
    expect(all.completeFrom).toBe(`${RANGE.since}T00:00:00Z`);
  });

  it("a missing issue, disabled Actions and an empty timeline degrade to absent facts; a failing timeline read throws with the status and a capped body", async () => {
    const gh = fakeGithub({
      ...ROUTES,
      "/repos/acme/api/issues/825": () => new Response("gone", { status: 404 }),
      [`/repos/acme/api/actions/runs?branch=${encodeURIComponent(BRANCH)}&per_page=100`]: () =>
        new Response("disabled", { status: 404 }),
      "/repos/acme/api/issues/917/timeline?per_page=100&page=1": [],
    });
    const source = new GithubDeliverySource({ fetch: gh.fetch, token: async () => "t" });
    const [pr] = (await source.fetchPullRequests(REPO, RANGE)).prs;
    expect(pr.issue).toBeUndefined();
    expect(pr.ci).toEqual([]);
    expect(pr.reviews).toEqual([]);
    expect(pr.firstHeadSha).toBe(HEAD);

    const broken = fakeGithub({
      ...ROUTES,
      "/repos/acme/api/issues/917/timeline?per_page=100&page=1": () =>
        new Response(`{"message":"boom ${"x".repeat(2000)}"}`, { status: 500 }),
    });
    await expect(
      new GithubDeliverySource({ fetch: broken.fetch, token: async () => "t" }).fetchPullRequests(REPO, RANGE),
    ).rejects.toThrow(/timeline.*HTTP 500 boom x{10}/);
  });

  it("without a GitHub credential nothing is fetched and the error names it", async () => {
    const gh = fakeGithub(ROUTES);
    const source = new GithubDeliverySource({ fetch: gh.fetch, token: async () => null });
    await expect(source.fetchPullRequests(REPO, RANGE)).rejects.toThrow(/no GitHub credential/);
    expect(gh.calls).toEqual([]);
  });
});
