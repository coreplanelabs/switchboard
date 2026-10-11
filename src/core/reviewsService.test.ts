import { DatabaseSync } from "node:sqlite";
import type { Predicate } from "./authz/types.js";
import { describe, expect, it } from "vitest";
import { InMemoryReviewFeedbackStore } from "./reviewFeedback.js";
import { DAY_MS, REVIEW_FEEDBACK_HOURLY_MS, REVIEWS_CACHE_OPEN_MS } from "./budgets.js";
import { METRICS_OFF_MESSAGE } from "./metricsService.js";
import type { MetricsRow, MetricsSource } from "./metrics.js";
import {
  createReviewsService,
  NullReviewsService,
  REVIEWS_CACHE_CLOSED_MS,
  REVIEWS_CACHE_SIZE,
} from "./reviewsService.js";

// Feature: record 0097, "The reader and the page" — eight reads per report,
// cached five minutes while the range fills and a day once it has ended.

const TODAY = Date.UTC(2026, 9, 11);

function countingSource(fail = false): MetricsSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    query(sql: string): Promise<MetricsRow[]> {
      reads.push(sql);
      return fail ? Promise.reject(new Error("analytics engine sql 500: boom")) : Promise.resolve([]);
    },
  };
}

describe("createReviewsService", () => {
  it("refreshes exact retained feedback while reusing the closed range's run queries", async () => {
    let at = TODAY;
    const store = new InMemoryReviewFeedbackStore(() => at);
    store.retain({
      runId: "original-review",
      repo: "sample/api",
      pr: 7,
      head: "a".repeat(40),
      bodyHash: "b".repeat(64),
      format: 1,
      findings: 1,
      publishedAt: TODAY - DAY_MS,
      review: {
        id: "71",
        nodeId: "review-71",
        url: "https://github.com/sample/api/pull/7#pullrequestreview-71",
        publishedAt: TODAY - DAY_MS,
      },
    });
    const source = countingSource();
    const cfg = { dataset: "d", feedback: { enabled: true, excludedActorIds: [], excludedPullRequests: [] } };
    const svc = createReviewsService(cfg, source, { now: () => at, feedback: store });
    const [claim] = await store.claim(at, 1);
    expect(
      await store.complete(
        claim!,
        {
          status: "complete",
          checkedAt: at,
          votes: [{ id: "vote-one", actorId: "person-one", actorType: "User", content: "up" }],
        },
        at,
      ),
    ).toBe(true);
    const range = { fromMs: TODAY - DAY_MS, toMs: TODAY };
    expect(await svc.reviews(range, { subject: "access:viewer", visibleTo: { kind: "all" } })).toMatchObject({
      feedback: { status: "available", total: { eligible: 1, positiveOnly: 1, positiveVotes: 1, ratedReviews: 1 } },
    });
    at += REVIEW_FEEDBACK_HOURLY_MS;
    const [refresh] = await store.claim(at, 1);
    expect(await store.complete(refresh!, { status: "complete", checkedAt: at, votes: [] }, at)).toBe(true);
    expect(await svc.reviews(range, { subject: "access:viewer", visibleTo: { kind: "all" } })).toMatchObject({
      feedback: {
        status: "available",
        total: { eligible: 1, positiveOnly: 0, unrated: 1, ratedReviews: 0, helpfulClearShare: null },
      },
    });
    expect(source.reads).toHaveLength(8);
    expect(
      await svc.reviews(range, { subject: "access:viewer", visibleTo: { kind: "user-is", userId: "access:viewer" } }),
    ).toMatchObject({ feedback: { status: "unavailable", asOf: at } });
    expect(
      await svc.reviews(range, { subject: "access:viewer", visibleTo: { kind: "user-is", userId: "access:person" } }),
    ).toMatchObject({ feedback: { status: "unavailable", asOf: at } });
  });
  it("keeps feedback storage failure separate from a healthy report and recovers without cached failure", async () => {
    let fail = true;
    class Store extends InMemoryReviewFeedbackStore {
      override async list(since: number, until: number) {
        if (fail) throw new Error("Private feedback failure");
        return super.list(since, until);
      }
    }
    const source = countingSource();
    const cfg = { dataset: "d", feedback: { enabled: true, excludedActorIds: [], excludedPullRequests: [] } };
    const svc = createReviewsService(cfg, source, { now: () => TODAY, feedback: new Store(() => TODAY) });
    const range = { fromMs: TODAY - DAY_MS, toMs: TODAY };
    const unavailable = await svc.reviews(range);
    expect(unavailable).toMatchObject({
      dataset: "d",
      usage: { runs: 0 },
      feedback: { status: "unavailable", asOf: TODAY },
    });
    expect(JSON.stringify(unavailable)).not.toContain("Private feedback failure");
    fail = false;
    expect(await svc.reviews(range)).toMatchObject({
      feedback: { status: "available", total: { eligible: 0, ratedReviews: 0, helpfulClearShare: null } },
    });
    expect(source.reads).toHaveLength(8);
  });
  it("answers one report from eight reads, naming its dataset", async () => {
    const source = countingSource();
    const svc = createReviewsService({ dataset: "switchboard_runs" }, source, { now: () => TODAY + 3_600_000 });
    const report = await svc.reviews({ fromMs: TODAY - 6 * DAY_MS, toMs: TODAY + DAY_MS });
    expect(source.reads).toHaveLength(8);
    expect(report.dataset).toBe("switchboard_runs");
    expect(report.usage.byDay).toHaveLength(7);
  });

  it("reuses a range that includes today for five minutes, and one that ended for a day", async () => {
    let at = TODAY + 3_600_000;
    const source = countingSource();
    const svc = createReviewsService({ dataset: "d" }, source, { now: () => at });
    const open = { fromMs: TODAY - DAY_MS, toMs: TODAY + DAY_MS };
    const closed = { fromMs: TODAY - 7 * DAY_MS, toMs: TODAY };
    await svc.reviews(open);
    await svc.reviews(closed);
    expect(source.reads).toHaveLength(16);
    at += REVIEWS_CACHE_OPEN_MS - 1;
    await svc.reviews(open);
    await svc.reviews(closed);
    expect(source.reads).toHaveLength(16);
    at += 2;
    await svc.reviews(open);
    await svc.reviews(closed);
    expect(source.reads).toHaveLength(24);
    at += REVIEWS_CACHE_CLOSED_MS;
    await svc.reviews(closed);
    expect(source.reads).toHaveLength(32);
  });

  it("never reuses a failed read, and refuses a bad range before reading", async () => {
    const source = countingSource(true);
    const svc = createReviewsService({ dataset: "d" }, source, { now: () => TODAY });
    const range = { fromMs: TODAY - DAY_MS, toMs: TODAY };
    await expect(svc.reviews(range)).rejects.toThrow(/500/);
    await expect(svc.reviews(range)).rejects.toThrow(/500/);
    expect(source.reads).toHaveLength(16);
    expect(() => svc.reviews({ fromMs: TODAY, toMs: TODAY - DAY_MS })).toThrow(/range/);
    expect(source.reads).toHaveLength(16);
  });

  it("holds at most a bounded number of ranges", async () => {
    const source = countingSource();
    const svc = createReviewsService({ dataset: "d" }, source, { now: () => TODAY });
    for (let i = 0; i <= REVIEWS_CACHE_SIZE; i++)
      await svc.reviews({ fromMs: TODAY - (i + 2) * DAY_MS, toMs: TODAY - DAY_MS });
    // The first range was dropped to make room, so asking again reads again.
    const before = source.reads.length;
    await svc.reviews({ fromMs: TODAY - 2 * DAY_MS, toMs: TODAY - DAY_MS });
    expect(source.reads.length).toBe(before + 8);
  });
});

describe("NullReviewsService", () => {
  it("refuses with the metrics-off sentence", async () => {
    await expect(new NullReviewsService().reviews()).rejects.toThrow(METRICS_OFF_MESSAGE);
  });
});

// SQLite executes the emitted WHERE text over distinct stored owners. Only the
// external Analytics aggregate functions are replaced by this fixture's sums.
describe("scoped review reports", () => {
  it("keeps literal Mine, Person and Everyone totals separate across caller, dataset and permission changes", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE d (timestamp INTEGER, index1 TEXT, blob1 TEXT, blob3 TEXT, blob7 TEXT, blob8 TEXT, blob9 TEXT, blob14 TEXT, blob20 TEXT, double1 INTEGER, double20 INTEGER)",
    );
    const insert = db.prepare("INSERT INTO d VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    for (const [owner, repo, n] of [
      ["access:alice", "org/one", 2],
      ["access:bob", "org/two", 3],
    ] as const)
      for (let i = 0; i < n; i++) {
        insert.run(TODAY / 1000, "review", "1", "", "", "slack:C1", repo, owner, "success", 10, TODAY);
        insert.run(TODAY / 1000, "review", "review-1", repo, owner, "", "", "", "", 0, 0);
      }
    // The review table has its own finish position (double1).
    db.exec(`UPDATE d SET double1 = ${TODAY} WHERE blob1 = 'review-1'`);
    db.exec("CREATE TABLE other AS SELECT * FROM d WHERE blob14 = 'access:alice' OR blob7 = 'access:alice'");
    const counts: number[] = [];
    const source: MetricsSource = {
      async query(sql, visibleTo) {
        if (visibleTo === undefined) throw new Error("missing read predicate");
        const table = /FROM (\w+) WHERE/.exec(sql)![1];
        const where = sql
          .split(" WHERE ")[1]
          .split(/ GROUP BY | ORDER BY /)[0]
          .replace(/toDateTime\((\d+)\)/g, "$1");
        const selected = db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all();
        counts.push(selected.length);
        if (sql.includes("AS outcome"))
          return selected.map((r) => ({
            day: new Date(TODAY).toISOString().slice(0, 10),
            surface: "mcp",
            outcome: "success",
            requester: r.blob14,
            runs: 1,
            wallMs: 10,
            maxInterval: 1,
          }));
        if (sql.includes("AS verdict"))
          return selected.map((r) => ({
            repository: r.blob3,
            pr: "1",
            verdict: "approved",
            reviews: 1,
            findings: 0,
            maxInterval: 1,
          }));
        return [];
      },
    };
    const config = { dataset: "d" };
    const service = createReviewsService(config, source, { now: () => TODAY });
    const range = { fromMs: TODAY, toMs: TODAY + DAY_MS };
    const mine: Predicate = { kind: "user-is", userId: "access:alice" };
    const person: Predicate = { kind: "user-is", userId: "access:bob" };
    const total = async (subject: string, visibleTo: Predicate) => {
      const r = await service.reviews(range, { subject, visibleTo });
      return [r.usage.runs, r.usage.verdicts.approved];
    };
    try {
      expect(await total("access:alice", mine)).toEqual([2, 2]);
      expect(counts).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
      expect(await total("access:admin", person)).toEqual([3, 3]);
      expect(await total("access:admin", { kind: "all" })).toEqual([5, 5]);
      expect(await total("access:alice", mine)).toEqual([2, 2]);
      expect(counts).toHaveLength(24);
      // A different actual credential does not borrow another caller's cache.
      expect(await total("access:other", mine)).toEqual([2, 2]);
      expect(counts).toHaveLength(32);
      expect(await total("access:admin", { kind: "none" })).toEqual([0, 0]);
      expect(counts.slice(-8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      config.dataset = "other";
      expect(await total("access:admin", { kind: "all" })).toEqual([2, 2]);
      expect(counts).toHaveLength(48);
      expect(await total("access:alice", { kind: "user-is", userId: "access:alice' OR 1=1 --" })).toEqual([0, 0]);
      expect(counts.slice(-8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      config.dataset = "d";
      expect(await total("access:admin", { kind: "channels-in", channelIds: new Set(["slack:C1"]) })).toEqual([5, 0]);
      expect(counts.slice(-8)).toEqual([5, 5, 5, 5, 5, 0, 5, 5]);

      for (const repo of ["", "ORG/SECRET", "ORG/PUBLIC"]) {
        insert.run(TODAY / 1000, "review", "1", "", "", "slack:C1", repo, "access:alice", "success", 10, TODAY);
        insert.run(TODAY / 1000, "review", "review-1", repo, "access:alice", "", "", "", "", TODAY, 0);
      }
      expect(await total("access:repo-policy", { kind: "repos-not-in", repos: new Set(["org/secret"]) })).toEqual([
        6, 6,
      ]);
      expect(counts.slice(-8)).toEqual([6, 6, 6, 6, 6, 6, 6, 6]);
      expect(await total("access:repo-policy", { kind: "repos-in", repos: new Set(["org/public"]) })).toEqual([1, 1]);
      expect(counts.slice(-8)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
      expect(() => service.reviews(range, { subject: "", visibleTo: mine })).toThrow("invalid reviews read subject");
      expect(() => service.reviews(range, { subject: "access:alice", visibleTo: undefined! })).toThrow(
        "invalid reviews read scope",
      );
    } finally {
      db.close();
    }
  });

  it("evicts scoped failed reads without poisoning the same caller's recovery", async () => {
    let fail = true;
    const source: MetricsSource = {
      async query() {
        if (fail) throw new Error("reader unavailable");
        return [];
      },
    };
    const svc = createReviewsService({ dataset: "d" }, source, { now: () => TODAY });
    const range = { fromMs: TODAY, toMs: TODAY + DAY_MS };
    const scope = { subject: "access:alice", visibleTo: { kind: "none" as const } };
    await expect(svc.reviews(range, scope)).rejects.toThrow("reader unavailable");
    fail = false;
    expect((await svc.reviews(range, scope)).dataset).toBe("d");
  });
});
