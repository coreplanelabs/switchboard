import { describe, expect, it } from "vitest";
import {
  buildDeliveryReport,
  coauthorsOf,
  createDeliveryService,
  DELIVERY_OFF_MESSAGE,
  InMemoryDeliverySource,
  NullDeliveryService,
  parseDeliveryConfig,
  parseFindings,
  pullRequestOfRun,
  renderDeliveryReport,
  resolveDeliveryRange,
  runFactsOf,
  SNAPSHOT_EVERY_MINUTES,
  snapshotAgeText,
  weekIncomplete,
  weekStartOf,
  type DeliveryIdentities,
  type DeliverySource,
  type PullRequestFacts,
  type RunFact,
} from "./delivery.js";

// The delivery indicators: pure arithmetic over facts a fetcher assembled from
// GitHub and the run history. The fixture is one trunk pass of six pull
// requests as GitHub recorded it (names replaced with the fixture's own:
// `alice` for the maintainer, `acme-review[bot]` for the review agent), so
// every indicator is asserted against a real day's shape: two fix rounds (one
// after a blocking finding, one after a minor one), one disposition round with
// no push, one CI retry, every push carrying an agent co-author, four of the
// six linked to a board issue.

const REVIEWER = "acme-review[bot]";
const AUTO_APPROVER = "github-actions[bot]";
const MAINTAINER = "alice";
const TRAILER = "\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>";

const IDENTITIES: DeliveryIdentities = { reviewers: [REVIEWER], agentLogins: [], agentCoauthors: ["Claude"] };

/** A bare calendar day from an instant (the hygiene ratchet reads a bare date as an imprint; an instant it does not). */
const dayOf = (iso: string): string => iso.slice(0, 10);
const WEEK = dayOf("2026-09-07T00:00:00Z");
const SINCE = WEEK;
const UNTIL = dayOf("2026-09-13T00:00:00Z");
const RANGE = { since: SINCE, until: UNTIL, weeks: 1 };

const lgtm = (at: string, sha: string, body = "LGTM: clean change, no findings.") => ({
  author: REVIEWER,
  state: "commented" as const,
  submittedAt: at,
  body,
  headSha: sha,
});
const autoApprove = (at: string, sha: string) => ({
  author: AUTO_APPROVER,
  state: "approved" as const,
  submittedAt: at,
  body: `Auto-approved: ${REVIEWER} reviewed this PR and posted an LGTM verdict.`,
  headSha: sha,
});
const ciOn = (sha: string, at: string, over: { attempt?: number; conclusion?: string | null } = {}) =>
  ["pr-title", "ci", "codeql"].map((name) => ({
    name,
    headSha: sha,
    trigger: "pull_request",
    conclusion: over.conclusion === undefined ? "success" : over.conclusion,
    attempt: over.attempt ?? 1,
    createdAt: at,
  }));
const AGENT = "Claude Fable 5.1 <noreply@anthropic.com>";
const commit = (at: string, message: string) => ({
  actor: "Alice Example",
  at,
  kind: "commit" as const,
  coauthors: coauthorsOf(message),
});
const forcePush = (at: string, coauthors: string[] = [AGENT]) => ({
  actor: MAINTAINER,
  at,
  kind: "force" as const,
  coauthors,
});

/** The six pull requests of the trunk pass, as GitHub reports them. */
export const TRUNK_PASS: PullRequestFacts[] = [
  {
    number: 915,
    title: "docs(providers): OpenRouter as a documented example",
    author: MAINTAINER,
    createdAt: "2026-09-10T23:58:58Z",
    mergedAt: "2026-09-11T00:03:24Z",
    firstHeadSha: "52226f19343423ab2fd1626354cb0a31658e93da",
    // The `ci` workflow needed a second attempt on the first head.
    ci: [
      ...ciOn("52226f19343423ab2fd1626354cb0a31658e93da", "2026-09-10T23:59:04Z").map((r) =>
        r.name === "ci" ? { ...r, attempt: 2 } : r,
      ),
      {
        name: "Auto-approve review LGTM",
        headSha: "52226f19343423ab2fd1626354cb0a31658e93da",
        trigger: "pull_request_review",
        conclusion: "success",
        attempt: 1,
        createdAt: "2026-09-11T00:00:27Z",
      },
    ],
    reviews: [
      lgtm("2026-09-11T00:00:23Z", "52226f19343423ab2fd1626354cb0a31658e93da"),
      autoApprove("2026-09-11T00:00:46Z", "52226f19343423ab2fd1626354cb0a31658e93da"),
    ],
    pushes: [commit("2026-09-10T23:54:52Z", `docs(providers): OpenRouter as a documented example${TRAILER}`)],
    issue: { number: 830, title: "OpenRouter as a documented example", createdAt: "2026-09-10T03:00:31Z" },
  },
  {
    number: 916,
    title: "docs(core): the record is accepted",
    author: MAINTAINER,
    createdAt: "2026-09-10T23:59:04Z",
    mergedAt: "2026-09-11T00:02:47Z",
    firstHeadSha: "aa035227d290ea383e7723fac09c976c83ea8538",
    ci: ciOn("aa035227d290ea383e7723fac09c976c83ea8538", "2026-09-10T23:59:07Z"),
    reviews: [
      lgtm("2026-09-11T00:01:51Z", "aa035227d290ea383e7723fac09c976c83ea8538"),
      autoApprove("2026-09-11T00:02:08Z", "aa035227d290ea383e7723fac09c976c83ea8538"),
    ],
    pushes: [commit("2026-09-10T23:54:45Z", `docs(core): the record is accepted${TRAILER}`)],
    issue: {
      number: 823,
      title: "Accept the record and put the program on the board",
      createdAt: "2026-09-10T03:00:05Z",
    },
  },
  {
    number: 917,
    title: "feat(resident): the mirror mutex is a durable lease",
    author: MAINTAINER,
    createdAt: "2026-09-10T23:59:09Z",
    mergedAt: "2026-09-11T00:18:40Z",
    firstHeadSha: "28837ecbdc07dd578743919c3a071dcd3756a47a",
    ci: [
      ...ciOn("28837ecbdc07dd578743919c3a071dcd3756a47a", "2026-09-10T23:59:14Z"),
      ...ciOn("c3bfbac617a8035845804b52a3212c20a93dec6a", "2026-09-11T00:13:45Z"),
    ],
    reviews: [
      {
        author: REVIEWER,
        state: "commented",
        submittedAt: "2026-09-11T00:05:15Z",
        headSha: "28837ecbdc07dd578743919c3a071dcd3756a47a",
        body: [
          "Changes requested: the resident invalidates its own live leases.",
          "- [blocking] F1 deploy/cloudflare-resident/worker.ts:1453 — Incarnation re-minted on every state transition",
          "- [minor] F2 deploy/cloudflare-resident/worker.ts — Watchdog's unconditional delete can race a fresh lease",
          "- [nit] F3 deploy/cloudflare-resident/worker.ts — Dead deps-holder sweep misses the staging dir",
          "",
          "Verdict: **request changes** — one blocking bug, otherwise a well-built change.",
        ].join("\n"),
      },
      lgtm(
        "2026-09-11T00:17:46Z",
        "c3bfbac617a8035845804b52a3212c20a93dec6a",
        "LGTM: All three prior findings verified fixed at head; no new issues.",
      ),
      autoApprove("2026-09-11T00:18:06Z", "c3bfbac617a8035845804b52a3212c20a93dec6a"),
    ],
    pushes: [
      commit("2026-09-11T00:13:23Z", `feat(resident): the mirror mutex is a durable lease${TRAILER}`),
      forcePush("2026-09-11T00:13:41Z"),
    ],
    issue: { number: 825, title: "The durable mutex and idempotent step methods", createdAt: "2026-09-10T03:00:12Z" },
  },
  {
    number: 919,
    title: "ci(release): the next release is pinned",
    author: MAINTAINER,
    createdAt: "2026-09-11T00:09:44Z",
    mergedAt: "2026-09-11T00:15:13Z",
    firstHeadSha: "375f7b48466f40d0bcfc5a59ba9764ce29b5d6c0",
    ci: ciOn("375f7b48466f40d0bcfc5a59ba9764ce29b5d6c0", "2026-09-11T00:09:48Z"),
    // Two findings answered by disposition: the second verdict came with no push.
    reviews: [
      {
        author: REVIEWER,
        state: "commented",
        submittedAt: "2026-09-11T00:11:38Z",
        headSha: "375f7b48466f40d0bcfc5a59ba9764ce29b5d6c0",
        body: [
          "Changes requested: the pin is not the public name and a config-level pin is sticky.",
          "- [blocking] F1 release-please-config.json:6 — semver parses the pin as minor 200",
          "- [major] F2 release-please-config.json:6 — a config-level pin holds every future release",
        ].join("\n"),
      },
      lgtm(
        "2026-09-11T00:14:02Z",
        "375f7b48466f40d0bcfc5a59ba9764ce29b5d6c0",
        "LGTM: Both round-1 findings are answered by deliberate owner policy; no code change needed.",
      ),
      autoApprove("2026-09-11T00:14:21Z", "375f7b48466f40d0bcfc5a59ba9764ce29b5d6c0"),
    ],
    pushes: [commit("2026-09-11T00:09:08Z", `ci(release): the next release is pinned${TRAILER}`)],
  },
  {
    number: 920,
    title: "feat(resident): the refresh cycle runs as a Workflow instance",
    author: MAINTAINER,
    createdAt: "2026-09-11T00:20:12Z",
    mergedAt: "2026-09-11T16:09:45Z",
    firstHeadSha: "d2e5e459ca3351fa913fe7f814626ae28ece9988",
    ci: [
      ...ciOn("d2e5e459ca3351fa913fe7f814626ae28ece9988", "2026-09-11T00:20:19Z"),
      ...ciOn("e144dbb1cce1db4b21eddcca84d22e8b45bdd661", "2026-09-11T16:02:01Z"),
      ...ciOn("a251190d14b640d44f2538b7389327af244561cf", "2026-09-11T16:07:59Z"),
    ],
    // An approving first verdict that still carried findings; a fix pushed later, then a re-review.
    reviews: [
      lgtm(
        "2026-09-11T00:23:44Z",
        "d2e5e459ca3351fa913fe7f814626ae28ece9988",
        [
          "LGTM: Careful port of the refresh cycle; only minor notes.",
          "- [minor] F1 src/core/costs.ts:656 — the dataset's filter field is unverified from here",
          "- [nit] F2 src/execution/residentInstanceId.ts:115 — duplicate detection by error wording",
          "- [nit] F3 deploy/cloudflare-resident/worker.ts — the file grows past 7k lines",
        ].join("\n"),
      ),
      autoApprove("2026-09-11T00:24:00Z", "d2e5e459ca3351fa913fe7f814626ae28ece9988"),
      lgtm(
        "2026-09-11T16:05:26Z",
        "e144dbb1cce1db4b21eddcca84d22e8b45bdd661",
        "LGTM: Re-review of the fix delta — no findings remain.",
      ),
      autoApprove("2026-09-11T16:07:36Z", "a251190d14b640d44f2538b7389327af244561cf"),
    ],
    pushes: [
      forcePush("2026-09-11T16:01:56Z"),
      commit("2026-09-11T16:07:52Z", `feat(resident): the refresh cycle runs as a Workflow instance${TRAILER}`),
      forcePush("2026-09-11T16:07:55Z"),
    ],
    issue: { number: 826, title: "The Workflows binding and the refresh cycle", createdAt: "2026-09-10T03:00:16Z" },
  },
  {
    number: 921,
    title: "docs(process): the branch unit is superseded by trunk",
    author: MAINTAINER,
    createdAt: "2026-09-11T00:22:56Z",
    mergedAt: "2026-09-11T00:26:44Z",
    firstHeadSha: "f7b45267fe7eb524b74138524089b059b86cc682",
    ci: ciOn("f7b45267fe7eb524b74138524089b059b86cc682", "2026-09-11T00:23:00Z"),
    reviews: [
      lgtm("2026-09-11T00:23:46Z", "f7b45267fe7eb524b74138524089b059b86cc682"),
      autoApprove("2026-09-11T00:24:06Z", "f7b45267fe7eb524b74138524089b059b86cc682"),
    ],
    pushes: [commit("2026-09-11T00:22:43Z", `docs(process): the branch unit is superseded by trunk${TRAILER}`)],
  },
];

const T = (iso: string): number => Date.parse(iso);

/** Two review runs keyed to the mutex pull request, one to the refresh one, one coding run keyed to nothing. */
const RUNS: RunFact[] = [
  {
    agent: "review",
    startedAt: T("2026-09-11T00:00:00Z"),
    finishedAt: T("2026-09-11T00:05:00Z"),
    status: "completed",
    pr: 917,
  },
  {
    agent: "review",
    startedAt: T("2026-09-11T00:14:00Z"),
    finishedAt: T("2026-09-11T00:17:30Z"),
    status: "completed",
    pr: 917,
  },
  {
    agent: "review",
    startedAt: T("2026-09-11T16:02:00Z"),
    finishedAt: T("2026-09-11T16:05:30Z"),
    status: "completed",
    pr: 920,
  },
  { agent: "coding", startedAt: T("2026-09-11T01:00:00Z"), finishedAt: T("2026-09-11T01:12:00Z"), status: "completed" },
];

const report = (over: Partial<Parameters<typeof buildDeliveryReport>[0]> = {}) =>
  buildDeliveryReport({ repo: "acme/api", range: RANGE, prs: TRUNK_PASS, runs: RUNS, identities: IDENTITIES, ...over });

describe("buildDeliveryReport — the trunk pass week", () => {
  it("counts six merged pull requests, none agent-authored, in the one week of the range", () => {
    const r = report();
    expect(r.weeks).toHaveLength(1);
    expect(r.weeks[0].week).toBe(WEEK);
    expect(r.weeks[0].prs).toEqual([915, 916, 917, 919, 920, 921]);
    expect(r.totals.prsMerged).toBe(6);
    expect(r.totals.agentAuthoredPrs).toBe(0);
  });

  it("issue-to-merge time runs from the linked board issue, or from the pull request's own opening when none is linked", () => {
    const r = report();
    const byNumber = Object.fromEntries(r.prs.map((p) => [p.number, p]));
    // Board issue at 03:00 the day before → merged 00:18 the next: about 21.3 h.
    expect(byNumber[917].leadTimeHours).toBeCloseTo(21.31, 2);
    expect(byNumber[920].leadTimeHours).toBeCloseTo(37.16, 2);
    // No issue: opened 00:09:44, merged 00:15:13 → 5.5 minutes.
    expect(byNumber[919].issue).toBeUndefined();
    expect(byNumber[919].leadTimeHours).toBeCloseTo(0.0914, 3);
    expect(r.totals.leadTimeHours.median).toBeCloseTo(21.05, 2);
    expect(r.totals.leadTimeHours.mean).toBeCloseTo(16.79, 2);
  });

  it("first-pass CI: the first head's pull_request runs all green at attempt one — five of six; the retried one fails it", () => {
    const r = report();
    const byNumber = Object.fromEntries(r.prs.map((p) => [p.number, p]));
    expect(byNumber[915].firstPassCi).toBe(false);
    expect(byNumber[917].firstPassCi).toBe(true);
    expect(r.totals.firstPassCi).toEqual({ passed: 5, known: 6, share: 5 / 6 });
  });

  it("review rounds are the review agent's verdicts; a fix round is a verdict that followed a push — nine verdicts, two fix rounds, 1.5 per PR", () => {
    const r = report();
    const byNumber = Object.fromEntries(r.prs.map((p) => [p.number, p]));
    expect(byNumber[917].reviewRounds).toBe(2);
    expect(byNumber[917].fixRounds).toBe(1);
    // A second verdict with no push between: a disposition round, not a fix round.
    expect(byNumber[919].reviewRounds).toBe(2);
    expect(byNumber[919].fixRounds).toBe(0);
    // An approving first verdict, a push, a re-review: one fix round.
    expect(byNumber[920].reviewRounds).toBe(2);
    expect(byNumber[920].fixRounds).toBe(1);
    expect(byNumber[915].reviewRounds).toBe(1);
    expect(r.totals.reviewRounds).toEqual({ verdicts: 9, fixRounds: 2, reviewed: 6, perPr: 1.5 });
    // The auto-approve identity's approvals are not verdicts.
    expect(r.prs.every((p) => p.approved)).toBe(true);
  });

  it("findings by severity — eight caught, two blocking — every one resolved with no human branch edit", () => {
    const r = report();
    expect(r.totals.findings).toEqual({
      total: 8,
      blocking: 2,
      major: 1,
      minor: 2,
      nit: 3,
      fyi: 0,
      noHumanEdit: 8,
      noHumanEditShare: 1,
    });
    const byNumber = Object.fromEntries(r.prs.map((p) => [p.number, p]));
    expect(byNumber[917].humanEdit).toBe(false);
    expect(byNumber[920].humanEdit).toBe(false);
  });

  it("agent run time is the run history's, keyed to the pull request a run named; an unkeyed run adds nothing", () => {
    const r = report();
    const byNumber = Object.fromEntries(r.prs.map((p) => [p.number, p]));
    expect(byNumber[917].agentRuns).toEqual({ count: 2, minutes: 8.5 });
    expect(byNumber[920].agentRuns).toEqual({ count: 1, minutes: 3.5 });
    expect(r.totals.agentRuns).toEqual({ count: 3, minutes: 12 });
  });

  it("units: one row per linked board issue with its indicators, and one row for the pull requests no issue claims", () => {
    const r = report();
    expect(r.units.map((u) => u.issue)).toEqual([823, 825, 826, 830, null]);
    const mutex = r.units.find((u) => u.issue === 825)!;
    expect(mutex.title).toBe("The durable mutex and idempotent step methods");
    expect(mutex.prs).toEqual([917]);
    expect(mutex.leadTimeHours.median).toBeCloseTo(21.31, 2);
    expect(mutex.reviewRounds).toEqual({ verdicts: 2, fixRounds: 1, reviewed: 1, perPr: 2 });
    expect(mutex.findings.blocking).toBe(1);
    const unlinked = r.units.find((u) => u.issue === null)!;
    expect(unlinked.prs).toEqual([919, 921]);
    expect(unlinked.findings.blocking).toBe(1);
  });

  it("the week row carries the same indicators as the totals when the range is one week", () => {
    const r = report();
    const { week: _week, until: _until, prs: _prs, ...indicators } = r.weeks[0];
    expect(indicators).toEqual(r.totals);
  });
});

describe("buildDeliveryReport — the edges", () => {
  it("a range with no merges renders zero rows for every week, not an error", () => {
    const r = buildDeliveryReport({
      repo: "acme/api",
      range: { since: dayOf("2026-08-24T00:00:00Z"), until: dayOf("2026-09-06T00:00:00Z"), weeks: 2 },
      prs: [],
      identities: IDENTITIES,
    });
    expect(r.weeks.map((w) => w.week)).toEqual([dayOf("2026-08-24T00:00:00Z"), dayOf("2026-08-31T00:00:00Z")]);
    for (const w of r.weeks) {
      expect(w.prsMerged).toBe(0);
      expect(w.leadTimeHours).toEqual({ median: null, mean: null });
      expect(w.firstPassCi).toEqual({ passed: 0, known: 0, share: null });
      expect(w.reviewRounds).toEqual({ verdicts: 0, fixRounds: 0, reviewed: 0, perPr: null });
      expect(w.findings.noHumanEditShare).toBeNull();
    }
    expect(r.units).toEqual([]);
    expect(r.totals.prsMerged).toBe(0);
  });

  it("a pull request merged outside the range is left out, whichever week it belongs to", () => {
    const r = report({
      prs: [...TRUNK_PASS, { ...TRUNK_PASS[0], number: 800, mergedAt: "2026-09-06T23:59:59Z" }],
    });
    expect(r.totals.prsMerged).toBe(6);
    expect(r.prs.map((p) => p.number)).not.toContain(800);
  });

  it("a human push after the first verdict counts every finding on that pull request against the no-human-edit share", () => {
    const withHuman = TRUNK_PASS.map((pr) =>
      pr.number === 917
        ? { ...pr, pushes: [{ actor: "bob", at: "2026-09-11T00:13:41Z", kind: "force" as const, coauthors: [] }] }
        : pr,
    );
    const r = report({ prs: withHuman });
    const pr = r.prs.find((p) => p.number === 917)!;
    expect(pr.humanEdit).toBe(true);
    // The three findings on that pull request are human-resolved; five of eight remain agent-resolved.
    expect(r.totals.findings.noHumanEdit).toBe(5);
    expect(r.totals.findings.noHumanEditShare).toBeCloseTo(5 / 8, 6);
  });

  it("a push by a bot login is an agent push even without a co-author trailer; a push before the first verdict is never a human edit", () => {
    const pr: PullRequestFacts = {
      ...TRUNK_PASS[2],
      pushes: [
        { actor: "bob", at: "2026-09-11T00:01:00Z", kind: "commit", coauthors: [] }, // before the first verdict
        { actor: "acme-coding[bot]", at: "2026-09-11T00:13:41Z", kind: "force", coauthors: [] },
      ],
    };
    expect(report({ prs: [pr] }).prs[0].humanEdit).toBe(false);
    const named: PullRequestFacts = {
      ...pr,
      pushes: [{ actor: "deploy-robot", at: "2026-09-11T00:13:41Z", kind: "force", coauthors: [] }],
    };
    expect(report({ prs: [named] }).prs[0].humanEdit).toBe(true);
    expect(
      report({ prs: [named], identities: { ...IDENTITIES, agentLogins: ["deploy-robot"] } }).prs[0].humanEdit,
    ).toBe(false);
  });

  it("a pull request with no verdict has no rounds, no findings and no human-edit judgement", () => {
    const pr: PullRequestFacts = { ...TRUNK_PASS[5], reviews: [], pushes: TRUNK_PASS[5].pushes };
    const row = report({ prs: [pr] }).prs[0];
    expect(row.reviewRounds).toBe(0);
    expect(row.approved).toBe(false);
    expect(row.humanEdit).toBeNull();
    expect(report({ prs: [pr] }).totals.reviewRounds).toEqual({ verdicts: 0, fixRounds: 0, reviewed: 0, perPr: null });
  });

  it("first-pass CI is unknown — neither passed nor failed — without a first head or without a pull_request run on it; a failed run fails it", () => {
    const noHead: PullRequestFacts = { ...TRUNK_PASS[5], number: 1, firstHeadSha: undefined, ci: [] };
    const onlyReviewTrigger: PullRequestFacts = {
      ...TRUNK_PASS[5],
      number: 2,
      ci: [{ ...TRUNK_PASS[5].ci[0], trigger: "pull_request_review" }],
    };
    const red: PullRequestFacts = {
      ...TRUNK_PASS[5],
      number: 3,
      ci: ciOn(TRUNK_PASS[5].firstHeadSha!, "2026-09-11T00:23:00Z", { conclusion: "failure" }),
    };
    // A push-triggered run on the branch is not the pull request's own check: red or green, it is not judged.
    const pushOnly: PullRequestFacts = {
      ...TRUNK_PASS[5],
      number: 4,
      ci: ciOn(TRUNK_PASS[5].firstHeadSha!, "2026-09-11T00:23:00Z", { conclusion: "failure" }).map((run) => ({
        ...run,
        trigger: "push",
      })),
    };
    const r = report({ prs: [red, onlyReviewTrigger, noHead, pushOnly] });
    // Rows come back in pull request number order, whatever order the facts arrived in.
    expect(r.prs.map((p) => p.firstPassCi)).toEqual([null, null, false, null]);
    expect(r.totals.firstPassCi).toEqual({ passed: 0, known: 1, share: 0 });
  });

  it("an agent-authored pull request is one whose author is a bot login or a configured agent login", () => {
    const r = report({
      prs: [
        { ...TRUNK_PASS[5], number: 1, author: "acme-coding[bot]" },
        { ...TRUNK_PASS[5], number: 2, author: "shipbot" },
        { ...TRUNK_PASS[5], number: 3, author: MAINTAINER },
      ],
      identities: { ...IDENTITIES, agentLogins: ["shipbot"] },
    });
    expect(r.prs.map((p) => p.agentAuthored)).toEqual([true, true, false]);
    expect(r.totals.agentAuthoredPrs).toBe(2);
  });

  it("weeks start on Monday, UTC; pull requests land in the week they merged", () => {
    expect(weekStartOf("2026-09-11T00:18:40Z")).toBe(dayOf("2026-09-07T00:00:00Z"));
    expect(weekStartOf("2026-09-07T00:00:00Z")).toBe(dayOf("2026-09-07T00:00:00Z"));
    expect(weekStartOf("2026-09-06T23:59:59Z")).toBe(dayOf("2026-08-31T00:00:00Z"));
    const r = buildDeliveryReport({
      repo: "acme/api",
      range: { since: dayOf("2026-08-31T00:00:00Z"), until: UNTIL, weeks: 2 },
      prs: [...TRUNK_PASS, { ...TRUNK_PASS[5], number: 900, mergedAt: "2026-09-06T12:00:00Z" }],
      identities: IDENTITIES,
    });
    expect(r.weeks.map((w) => [w.week, w.prsMerged])).toEqual([
      [dayOf("2026-08-31T00:00:00Z"), 1],
      [dayOf("2026-09-07T00:00:00Z"), 6],
    ]);
    expect(r.totals.prsMerged).toBe(7);
  });

  it("carries the identities it judged by and whether the fetch was cut short", () => {
    const r = report({ truncated: true });
    expect(r.identities).toEqual(IDENTITIES);
    expect(r.truncated).toBe(true);
    expect(report().truncated).toBe(false);
  });
});

describe("parseFindings", () => {
  it("reads the review agent's finding lines by severity and ignores everything else", () => {
    expect(
      parseFindings(
        [
          "Changes requested: two problems.",
          "- [blocking] F1 a.ts:1 — the bug",
          "- [major] F2 b.ts — the design",
          "* [minor] F3 c.ts — the style",
          "  - [nit] F4 — a nit",
          "- [fyi] F5 — a note",
          "- [blocker] F6 — the other spelling",
          "**F1 (blocking)** — prose that repeats the finding is not a second finding",
          "[minor] not a list item, still a finding line",
        ].join("\n"),
      ),
    ).toEqual(["blocking", "major", "minor", "nit", "fyi", "blocking", "minor"]);
    expect(parseFindings("LGTM: nothing to report")).toEqual([]);
    expect(parseFindings("")).toEqual([]);
  });
});

describe("resolveDeliveryRange", () => {
  const NOW = new Date("2026-09-11T20:00:00Z");
  it("`weeks` counts back from the current week's Monday; the default is four; the count is clamped", () => {
    expect(resolveDeliveryRange({}, NOW)).toEqual({
      since: dayOf("2026-08-17T00:00:00Z"),
      until: dayOf("2026-09-11T00:00:00Z"),
      weeks: 4,
    });
    expect(resolveDeliveryRange({ weeks: 1 }, NOW)).toEqual({
      since: WEEK,
      until: dayOf("2026-09-11T00:00:00Z"),
      weeks: 1,
    });
    expect(resolveDeliveryRange({ weeks: 99 }, NOW).weeks).toBe(26);
    expect(resolveDeliveryRange({ weeks: 0 }, NOW).weeks).toBe(1);
    expect(resolveDeliveryRange({ weeks: Number.NaN }, NOW).weeks).toBe(4);
  });
  it("`since` names the first day and the week count follows; a malformed date is the default", () => {
    expect(resolveDeliveryRange({ since: dayOf("2026-08-20T00:00:00Z") }, NOW)).toEqual({
      since: dayOf("2026-08-20T00:00:00Z"),
      until: dayOf("2026-09-11T00:00:00Z"),
      weeks: 4,
    });
    expect(resolveDeliveryRange({ since: "yesterday" }, NOW).weeks).toBe(4);
    // A start after today is pulled back to today.
    expect(resolveDeliveryRange({ since: dayOf("2026-12-01T00:00:00Z") }, NOW).since).toBe(
      dayOf("2026-09-11T00:00:00Z"),
    );
  });
});

describe("runFactsOf / pullRequestOfRun", () => {
  it("keys a run to the pull request its label names, on the report's repository only", () => {
    expect(
      pullRequestOfRun('review · acme/api · "please review https://github.com/acme/api/pull/42 — the change"'),
    ).toBe(42);
    expect(pullRequestOfRun('coding · acme/api · "fix the build"')).toBeUndefined();
    const rows = [
      {
        repo: "acme/api",
        agent: "review",
        startedAt: 1_000,
        finishedAt: 61_000,
        finished: true,
        status: "completed",
        label: 'review · acme/api · "https://github.com/acme/api/pull/7"',
      },
      {
        repo: "acme/web",
        agent: "review",
        startedAt: 1_000,
        finishedAt: 61_000,
        finished: true,
        status: "completed",
        label: 'review · acme/web · "https://github.com/acme/web/pull/7"',
      },
      { repo: "acme/api", agent: "coding", startedAt: 1_000, finished: false },
    ];
    expect(runFactsOf(rows, "acme/api")).toEqual([
      { agent: "review", startedAt: 1_000, finishedAt: 61_000, status: "completed", pr: 7 },
    ]);
  });
});

describe("renderDeliveryReport", () => {
  it("prints one block per week — the counts, the times, the shares — then the units, in single-spaced lines chat can carry", () => {
    const text = renderDeliveryReport(report());
    expect(text).toContain(`acme/api · ${SINCE} → ${UNTIL} · 1 week`);
    expect(text).toContain(`Week of ${WEEK}: 6 merged (0 agent-authored)`);
    expect(text).toContain("issue → merge: median 21.0 h · mean 16.8 h");
    expect(text).toContain("first-pass CI: 5/6 (83%)");
    expect(text).toContain("review rounds: 1.50 per PR (9 verdicts, 2 fix rounds)");
    expect(text).toContain("findings: 8 (2 blocking, 1 major, 2 minor, 3 nit) · 100% resolved with no human edit");
    expect(text).toContain("agent runs: 3 · 12.0 min");
    expect(text).toContain("Units:");
    expect(text).toContain(
      "• 825 The durable mutex and idempotent step methods — PR 917 · 21.3 h · 2 rounds · 1 blocking",
    );
    expect(text).toContain("• (no issue) — PRs 919, 921");
    expect(text).not.toMatch(/\S {2,}\S/);
  });
  it("a week with nothing merged says so; a cut-short fetch is stated on the first line — the newest N pull requests only, complete from an instant — and the weeks that began before that instant are marked incomplete", () => {
    const now = Date.parse("2026-09-12T03:16:00Z");
    const twoWeeks = buildDeliveryReport({
      repo: "acme/api",
      range: { since: dayOf("2026-08-31T00:00:00Z"), until: UNTIL, weeks: 2 },
      prs: TRUNK_PASS,
      identities: IDENTITIES,
      truncated: true,
    });
    const text = renderDeliveryReport({ ...twoWeeks, completeFrom: "2026-09-03T02:41:37Z" }, now);
    expect(text.split("\n")[0]).toBe(
      `acme/api · ${dayOf("2026-08-31T00:00:00Z")} → ${UNTIL} · 2 weeks · the newest 6 pull requests only, complete from ${dayOf("2026-09-03T00:00:00Z")} 02:41 UTC`,
    );
    expect(text).toContain(`Week of ${dayOf("2026-08-31T00:00:00Z")} (incomplete): nothing merged`);
    expect(text).toContain(`Week of ${WEEK}: 6 merged`);
    expect(text).not.toContain("the fetch stopped");
    // A truncated report that names no instant (a bare source) still says the newest N pull requests only; no week is marked.
    const bare = renderDeliveryReport(twoWeeks, now);
    expect(bare.split("\n")[0]).toMatch(/ · the newest 6 pull requests only$/);
    expect(bare).not.toContain("(incomplete)");
    // A complete report says nothing of the kind.
    expect(renderDeliveryReport(report(), now)).not.toContain("newest");
    // The week holding the instant is partial, so incomplete; the week after is complete; a complete report marks nothing.
    const cut = { truncated: true, completeFrom: "2026-09-03T02:41:37Z" };
    expect(weekIncomplete(cut, dayOf("2026-08-31T00:00:00Z"))).toBe(true);
    expect(weekIncomplete(cut, WEEK)).toBe(false);
    expect(weekIncomplete({ ...cut, truncated: false }, dayOf("2026-08-31T00:00:00Z"))).toBe(false);
    expect(weekIncomplete({ truncated: true }, dayOf("2026-08-31T00:00:00Z"))).toBe(false);
  });
  it("names the snapshot's time and age on the first line when the report carries one, and says nothing about it when it does not", () => {
    const at = "2026-09-11T13:51:00Z";
    const now = Date.parse("2026-09-11T14:03:30Z");
    const text = renderDeliveryReport({ ...report(), snapshotAt: at }, now);
    expect(text.split("\n")[0]).toBe(
      `acme/api · ${SINCE} → ${UNTIL} · 1 week · as of ${dayOf(at)} 13:51 UTC, 12 minutes ago`,
    );
    expect(renderDeliveryReport(report(), now).split("\n")[0]).toBe(`acme/api · ${SINCE} → ${UNTIL} · 1 week`);
    expect(snapshotAgeText(at, now)).toBe("12 minutes ago");
    expect(snapshotAgeText(at, Date.parse("2026-09-11T13:51:20Z"))).toBe("just now");
    expect(snapshotAgeText(at, Date.parse("2026-09-11T14:52:00Z"))).toBe("61 minutes ago");
    expect(snapshotAgeText(at, Date.parse("2026-09-11T16:30:00Z"))).toBe("3 hours ago");
    expect(snapshotAgeText(at, Date.parse("2026-09-14T16:30:00Z"))).toBe("3 days ago");
  });
});

describe("parseDeliveryConfig", () => {
  it("absent → undefined; repos and identities validated; a malformed block throws by name", () => {
    expect(parseDeliveryConfig(undefined)).toBeUndefined();
    expect(
      parseDeliveryConfig({ repos: ["acme/api"], reviewers: ["acme-review[bot]"], agentLogins: ["shipbot"] }),
    ).toEqual({
      repos: ["acme/api"],
      reviewers: ["acme-review[bot]"],
      agentLogins: ["shipbot"],
      agentCoauthors: [],
      snapshot: { everyMinutes: 60 },
    });
    expect(parseDeliveryConfig({})).toEqual({
      repos: [],
      reviewers: [],
      agentLogins: [],
      agentCoauthors: [],
      snapshot: { everyMinutes: 60 },
    });
    expect(() => parseDeliveryConfig({ repos: "acme/api" })).toThrow(/delivery\.repos/);
    expect(() => parseDeliveryConfig({ repos: ["not a slug"] })).toThrow(/delivery\.repos/);
    expect(() => parseDeliveryConfig("yes")).toThrow(/delivery: must be a mapping/);
  });
  it("snapshot.everyMinutes is the refresh interval — a whole number of minutes within bounds, 60 by default; anything else throws by name", () => {
    expect(parseDeliveryConfig({ snapshot: { everyMinutes: 15 } })!.snapshot).toEqual({ everyMinutes: 15 });
    expect(parseDeliveryConfig({ snapshot: {} })!.snapshot).toEqual({ everyMinutes: 60 });
    expect(SNAPSHOT_EVERY_MINUTES).toEqual({ default: 60, min: 5, max: 1440 });
    for (const bad of [0, 4, 1441, 7.5, "60", null]) {
      expect(() => parseDeliveryConfig({ snapshot: { everyMinutes: bad } })).toThrow(
        /delivery\.snapshot\.everyMinutes must be a whole number of minutes between 5 and 1440/,
      );
    }
    expect(() => parseDeliveryConfig({ snapshot: [] })).toThrow(/delivery\.snapshot must be a mapping/);
  });
});

describe("createDeliveryService / NullDeliveryService", () => {
  const source = new InMemoryDeliverySource({ "acme/api": TRUNK_PASS });
  const now = () => new Date("2026-09-11T20:00:00Z");

  it("reports a configured repository — or any named one — over the resolved range, with the identities merged from config and the process", async () => {
    const service = createDeliveryService(
      parseDeliveryConfig({ repos: ["acme/api"], agentCoauthors: ["Claude"] }),
      source,
      { identities: async () => ({ reviewers: [REVIEWER] }), now },
    );
    expect(service.repos()).toEqual(["acme/api"]);
    const seen: unknown[] = [];
    const r = await service.report("acme/api", {
      weeks: 1,
      runs: async (range) => {
        seen.push(range);
        return RUNS;
      },
    });
    expect(seen).toEqual([RANGE_TO(now())]);
    expect(r.totals.agentRuns).toEqual({ count: 3, minutes: 12 });
    expect(r.range).toEqual(RANGE_TO(now()));
    expect(r.totals.prsMerged).toBe(6);
    expect(r.identities).toEqual({ reviewers: [REVIEWER], agentLogins: [], agentCoauthors: ["Claude"] });
    expect(source.calls).toEqual([{ repo: "acme/api", range: RANGE_TO(now()) }]);
    // An unconfigured repository is still readable by name (the command's --repo).
    const other = await service.report("acme/web", { weeks: 1 });
    expect(other.totals.prsMerged).toBe(0);
  });

  it("stamps the report with when its facts were read — the source's read time when it names one, else now — and from when they are complete, and hands `fresh` to the source", async () => {
    const plain = createDeliveryService(undefined, source, { now });
    const stampedNow = await plain.report("acme/api", { weeks: 1 });
    expect(stampedNow.snapshotAt).toBe(now().toISOString());
    expect(stampedNow.completeFrom).toBeUndefined();
    const stamped: DeliverySource = {
      fetchPullRequests: () =>
        Promise.resolve({
          prs: TRUNK_PASS,
          truncated: true,
          completeFrom: "2026-09-09T02:41:37Z",
          fetchedAt: "2026-09-11T13:00:00Z",
        }),
    };
    const fromSnapshot = await createDeliveryService(undefined, stamped, { now }).report("acme/api", { weeks: 1 });
    expect(fromSnapshot.snapshotAt).toBe("2026-09-11T13:00:00Z");
    expect(fromSnapshot.truncated).toBe(true);
    expect(fromSnapshot.completeFrom).toBe("2026-09-09T02:41:37Z");
    expect(fromSnapshot.totals.prsMerged).toBe(6);
    const recording = new InMemoryDeliverySource({ "acme/api": TRUNK_PASS });
    await createDeliveryService(undefined, recording, { now }).report("acme/api", { weeks: 1, fresh: true });
    await createDeliveryService(undefined, recording, { now }).report("acme/api", { weeks: 1 });
    expect(recording.calls.map((c) => c.fresh)).toEqual([true, undefined]);
  });

  it("refuses a repository that is not `owner/name`", async () => {
    const service = createDeliveryService(undefined, source, { now });
    expect(service.repos()).toEqual([]);
    await expect(service.report("../etc", {})).rejects.toThrow(/owner\/name/);
  });

  it("the Null Object has no repository and refuses every report with the reason", async () => {
    const service = new NullDeliveryService();
    expect(service.repos()).toEqual([]);
    expect(service.unavailable()).toBe(DELIVERY_OFF_MESSAGE);
    await expect(service.report("acme/api", {})).rejects.toThrow(DELIVERY_OFF_MESSAGE);
    expect(createDeliveryService(undefined, source, { now }).unavailable()).toBeUndefined();
  });
});

function RANGE_TO(now: Date) {
  return resolveDeliveryRange({ weeks: 1 }, now);
}
