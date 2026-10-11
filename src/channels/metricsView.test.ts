import { readableRuns } from "./liveView/viewer.js";
import { matchesPredicate } from "../core/authz/predicate.js";
import { buildReviewsReport } from "../core/reviewsReport.js";
import { NullReviewsService, type ReviewsService, type ReviewsReadScope } from "../core/reviewsService.js";
import { describe, expect, it, vi } from "vitest";
import { DAY_MS } from "../core/budgets.js";
import { InMemoryMetricsSource } from "../core/metrics.js";
import { createMetricsService } from "../core/metricsService.js";
import { POINT_COLUMNS, POINT_SCHEMA, type RunMetricsPoint } from "../core/runMetrics.js";
import { ALL_GRANTS } from "../core/authz/grants.js";
import { NO_GRANTS, type Actor } from "../core/authz/types.js";
import { accessActor } from "./commandHttp.js";
import { resolveWorkViewScope, withWorkViewScope } from "./workViewScope.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import { buildMetricsReport, MetricsSourceError, type MetricsReport } from "../core/metrics.js";
import { METRICS_OFF_MESSAGE, NullMetricsService, type MetricsService } from "../core/metricsService.js";
import {
  createMetricsViewHandler,
  parseMetricsRoute,
  createReviewsMetricsViewHandler,
  parseReviewsMetricsRoute,
} from "./metricsView.js";
import { SEED_ELEMENT_ID, type MetricsSeed, type ReviewsMetricsSeed } from "./webSeed.js";
import { makePageSender } from "./webShell.js";

// The metrics page handler (run-metrics.md item 10): routing, the seed the
// shell carries, the JSON twin, the query knobs, and the off/error statuses.
// Review-tab rendering is tested in web/green/pages/metrics.test.ts.

// ---- fixtures ---------------------------------------------------------------

/** A whole-UTC-day window ending well after the epoch, computed — never a literal date. */
const UNTIL_MS = 20_700 * DAY_MS;

function report(days = 7): MetricsReport {
  const sinceMs = UNTIL_MS - days * DAY_MS;
  const dayIso = (i: number) => new Date(sinceMs + i * DAY_MS).toISOString().slice(0, 10);
  return {
    dataset: "switchboard_runs",
    ...buildMetricsReport(
      {
        byDayStatus: [
          { day: `${dayIso(0)} 00:00:00`, status: "completed", runs: 18 },
          { day: `${dayIso(0)} 00:00:00`, status: "failed", runs: 2 },
          { day: `${dayIso(2)} 00:00:00`, status: "completed", runs: 5 },
        ],
        byAgent: [
          {
            agent: "coding",
            runs: 25,
            failed: 2,
            p50WallMs: 60_000,
            p95WallMs: 300_000,
            usd: 12.5,
            unpricedTokens: 0,
            turns: 400,
          },
        ],
        byDayAgentP50: [{ day: `${dayIso(0)} 00:00:00`, agent: "coding", p50WallMs: 60_000 }],
      },
      { sinceMs, untilMs: UNTIL_MS, days },
    ),
  };
}

const sendPage = makePageSender({ js: "/assets/main-test.js", css: [] }, ALL_CAPABILITIES);

function seedOf(html: string): MetricsSeed {
  const m = new RegExp(`<script type="application/json" id="${SEED_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
  if (!m) throw new Error("no seed island in the page");
  return JSON.parse(m[1]) as MetricsSeed;
}

function fakeService(impl: MetricsService["report"]): MetricsService & { report: ReturnType<typeof vi.fn> } {
  return { report: vi.fn(impl), feedback: () => new NullMetricsService().feedback() };
}

function fakeReqRes(method: string, url: string) {
  let status = 0;
  let outHeaders: Record<string, string> = {};
  const chunks: string[] = [];
  const req = { method, url, headers: {} };
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s;
      outHeaders = h ?? {};
    },
    write: (c: string) => void chunks.push(c),
    end: (c?: string) => {
      if (c) chunks.push(c);
    },
  };
  return {
    req: req as unknown as Parameters<ReturnType<typeof createMetricsViewHandler>>[0],
    res: res as unknown as Parameters<ReturnType<typeof createMetricsViewHandler>>[1],
    get status() {
      return status;
    },
    get headers() {
      return outHeaders;
    },
    body: () => chunks.join(""),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- routing ----------------------------------------------------------------

describe("parseMetricsRoute", () => {
  it("matches the page and its JSON twin, and nothing else", () => {
    expect(parseMetricsRoute("/metrics")).toEqual({ kind: "page" });
    expect(parseMetricsRoute("/metrics/")).toEqual({ kind: "page" });
    expect(parseMetricsRoute("/metrics.json")).toEqual({ kind: "json" });
    expect(parseMetricsRoute("/metrics/x")).toBeNull();
    expect(parseMetricsRoute("/metricsx")).toBeNull();
    expect(parseMetricsRoute("/costs")).toBeNull();
  });
});

// ---- handler ----------------------------------------------------------------

describe("createMetricsViewHandler", () => {
  it("falls through on other paths and refuses non-GET with 405", async () => {
    const service = fakeService(async () => report());
    const handler = createMetricsViewHandler(service, sendPage);
    const other = fakeReqRes("GET", "/runs");
    expect(handler(other.req, other.res)).toBe(false);
    const post = fakeReqRes("POST", "/metrics");
    expect(handler(post.req, post.res)).toBe(true);
    await tick();
    expect(post.status).toBe(405);
    expect(service.report).not.toHaveBeenCalled();
  });

  it("serves the page with the report as the MetricsSeed, and the twin answers the seed's report exactly", async () => {
    const r = report();
    const service = fakeService(async () => r);
    const handler = createMetricsViewHandler(service, sendPage);
    const page = fakeReqRes("GET", "/metrics");
    expect(handler(page.req, page.res)).toBe(true);
    await tick();
    expect(page.status).toBe(200);
    const seed = seedOf(page.body());
    expect(seed.page).toBe("metrics");
    expect(seed.report).toEqual(JSON.parse(JSON.stringify(r)));
    expect(page.body()).toContain("<title>Metrics by run</title>");
    const twin = fakeReqRes("GET", "/metrics.json");
    expect(handler(twin.req, twin.res)).toBe(true);
    await tick();
    expect(twin.status).toBe(200);
    expect(JSON.parse(twin.body())).toEqual(seed.report);
  });

  it("passes ?days and ?agent through to the service", async () => {
    const service = fakeService(async () => report(7));
    const handler = createMetricsViewHandler(service, sendPage);
    const t = fakeReqRes("GET", "/metrics.json?days=7&agent=coding");
    expect(handler(t.req, t.res)).toBe(true);
    await tick();
    expect(service.report).toHaveBeenCalledWith({ days: 7, agent: "coding", visibleTo: { kind: "none" } });
    const bare = fakeReqRes("GET", "/metrics");
    handler(bare.req, bare.res);
    await tick();
    expect(service.report).toHaveBeenLastCalledWith({ visibleTo: { kind: "none" } });
  });

  it("refuses a malformed ?days or ?agent with 400 before any read", async () => {
    const service = fakeService(async () => report());
    const handler = createMetricsViewHandler(service, sendPage);
    for (const query of ["days=0", "days=91", "days=1.5", "days=abc"]) {
      const t = fakeReqRes("GET", `/metrics?${query}`);
      expect(handler(t.req, t.res)).toBe(true);
      await tick();
      expect(t.status).toBe(400);
      expect(t.body()).toContain("metrics days must be a whole number between 1 and 90");
    }
    const bad = fakeReqRes("GET", "/metrics.json?agent=no'quote");
    expect(handler(bad.req, bad.res)).toBe(true);
    await tick();
    expect(bad.status).toBe(400);
    expect(bad.body()).toContain("agent name");
    expect(service.report).not.toHaveBeenCalled();
  });

  it("answers 503 with the off message when the reader is off — the Null service — on the page and the twin", async () => {
    const handler = createMetricsViewHandler(new NullMetricsService(), sendPage);
    for (const path of ["/metrics", "/metrics.json"]) {
      const t = fakeReqRes("GET", path);
      expect(handler(t.req, t.res)).toBe(true);
      await tick();
      expect(t.status).toBe(503);
      expect(t.body()).toBe(METRICS_OFF_MESSAGE);
    }
  });

  it("answers 503 naming the error's class when a source fails, never its detail", async () => {
    const service = fakeService(async () => {
      throw new MetricsSourceError(403, "token secret-words rejected");
    });
    const handler = createMetricsViewHandler(service, sendPage);
    const t = fakeReqRes("GET", "/metrics.json");
    expect(handler(t.req, t.res)).toBe(true);
    await tick();
    expect(t.status).toBe(503);
    expect(t.body()).toBe("metrics by run unavailable: MetricsSourceError");
    expect(t.body()).not.toContain("secret-words");
  });
});

describe("current work metrics projection", () => {
  const now = 20_700 * DAY_MS + 1000;
  const point = (userId: string, agent: string, usd: number, status = "completed"): RunMetricsPoint => {
    const blobs = POINT_COLUMNS.blobs.map(() => "");
    const doubles = POINT_COLUMNS.doubles.map(() => 0);
    for (const [field, value] of [
      ["schema", POINT_SCHEMA],
      ["requester", userId],
      ["agent", agent],
      ["status", status],
      ["channel", "access:shared"],
      ["repository", "demo/repo"],
    ] as const)
      blobs[POINT_COLUMNS.blobs.indexOf(field)] = value;
    doubles[POINT_COLUMNS.doubles.indexOf("dollars")] = usd;
    doubles[POINT_COLUMNS.doubles.indexOf("finished at")] = now;
    doubles[POINT_COLUMNS.doubles.indexOf("wall")] = 1000;
    doubles[POINT_COLUMNS.doubles.indexOf("turns")] = 1;
    return { indexes: [agent], blobs, doubles };
  };
  const points = [
    point("access:alice", "coding", 2),
    point("access:bob", "review", 3, "failed"),
    point("access:bob", "coding", 4),
    point("access:carol", "coding", 5),
  ];
  const readGrants = { ...ALL_GRANTS, actions: new Set(["runs:read", "metrics:read"]) };
  const reader = accessActor({ sub: "alice" }, () => readGrants);
  const admin = accessActor({ sub: "admin" }, () => ALL_GRANTS);
  const person: Actor = {
    ...admin,
    onBehalfOf: accessActor({ sub: "bob" }, () => readGrants),
    viewingAs: { id: "access:bob" },
  };
  withWorkViewScope(reader, resolveWorkViewScope(reader, { organization: "installation" }));
  withWorkViewScope(admin, resolveWorkViewScope(admin, { organization: "installation", mode: "everyone" }));
  withWorkViewScope(person, resolveWorkViewScope(person, { organization: "installation", originalActor: admin }));
  const denied: Actor = { kind: "service", id: "access:svc:no-read", grants: NO_GRANTS };
  withWorkViewScope(denied, resolveWorkViewScope(denied, { organization: "installation" }));

  it("filters Mine, read-only Person and authorized Everyone before aggregation on the page and JSON twin", async () => {
    const service = createMetricsService({ dataset: "fixture_runs", days: 7 }, new InMemoryMetricsSource(points), {
      now: () => now,
    });
    const handler = createMetricsViewHandler(service, sendPage);
    for (const [actor, expected] of [
      [reader, { runs: 1, failed: 0, usd: 2 }],
      [person, { runs: 2, failed: 1, usd: 7 }],
      [admin, { runs: 4, failed: 1, usd: 14 }],
      [denied, { runs: 0, failed: 0, usd: 0 }],
    ] as const) {
      for (const path of ["/metrics?all=1&person=access:carol", "/metrics.json?all=1&person=access:carol"]) {
        const request = fakeReqRes("GET", path);
        expect(handler(request.req, request.res, { actor })).toBe(true);
        await tick();
        expect(request.status).toBe(200);
        const report = path.startsWith("/metrics.json") ? JSON.parse(request.body()) : seedOf(request.body()).report;
        expect({ runs: report.tiles.runs, failed: report.tiles.failed, usd: report.tiles.usd }).toEqual(expected);
      }
    }
  });

  it("does not substitute global totals when scoped source reads are unavailable", async () => {
    const source = {
      query: async () => {
        throw new MetricsSourceError(503, "private provider detail");
      },
    };
    const service = createMetricsService({ dataset: "fixture_runs", days: 7 }, source, { now: () => now });
    const handler = createMetricsViewHandler(service, sendPage);
    const request = fakeReqRes("GET", "/metrics.json");
    handler(request.req, request.res, { actor: reader });
    await tick();
    expect(request.status).toBe(503);
    expect(request.body()).toBe("metrics by run unavailable: MetricsSourceError");
  });
});

describe("protected review metrics HTTP", () => {
  const now = 20_700 * DAY_MS + 1000;
  const readGrants = { ...ALL_GRANTS, actions: new Set(["runs:read", "metrics:read"]) };
  function selected(sub: string, mode: "mine" | "everyone" = "mine"): Actor {
    const actor = accessActor({ sub }, () => (mode === "everyone" ? ALL_GRANTS : readGrants));
    return withWorkViewScope(actor, resolveWorkViewScope(actor, { organization: "installation", mode }));
  }
  function person(): Actor {
    const admin = accessActor({ sub: "admin" }, () => ALL_GRANTS);
    const actor: Actor = {
      ...admin,
      onBehalfOf: accessActor({ sub: "bob" }, () => readGrants),
      viewingAs: { id: "access:bob" },
    };
    return withWorkViewScope(
      actor,
      resolveWorkViewScope(actor, { organization: "installation", originalActor: admin }),
    );
  }
  function scopedReader(): ReviewsService {
    return {
      async reviews(range, scope?: ReviewsReadScope) {
        if (!scope) throw new Error("no global fallback");
        const records = [
          { userId: "access:alice", runs: 2 },
          { userId: "access:bob", runs: 3 },
          { userId: "access:carol", runs: 4 },
        ];
        const rows = records.filter((row) =>
          matchesPredicate(scope.visibleTo, {
            ...row,
            repo: "sample/api",
            channelId: "web:shared",
            channelVisibility: "public",
          }),
        );
        const day = new Date(range.fromMs).toISOString().slice(0, 10);
        return {
          dataset: "fixture_reviews",
          ...buildReviewsReport(
            {
              runs: rows.map((row) => ({
                day,
                requester: row.userId,
                outcome: "success",
                surface: "mcp",
                runs: row.runs,
                wallMs: row.runs * 1000,
                maxInterval: 1,
              })),
              durationByRequester: [],
              durationBySurface: [],
              durationOverall: [],
              durationHistogram: [],
              reviews: [],
              setup: [],
              byWorkspace: [],
            },
            range,
          ),
        };
      },
    };
  }
  function invoke(
    handler: ReturnType<typeof createReviewsMetricsViewHandler>,
    path: string,
    actor?: Actor,
    current: () => Promise<Actor | undefined> = async () => actor,
    method = "GET",
  ) {
    const request = fakeReqRes(method, path);
    expect(handler(request.req, request.res, { actor, currentActor: current })).toBe(true);
    return request;
  }
  function reviewSeed(body: string): ReviewsMetricsSeed {
    return seedOf(body) as unknown as ReviewsMetricsSeed;
  }
  it("routes the two tabs and JSON twin without claiming unrelated addresses", () => {
    expect(["/metrics", "/metrics/health", "/metrics.json"].map(parseReviewsMetricsRoute)).toEqual([
      { kind: "usage" },
      { kind: "health" },
      { kind: "json" },
    ]);
    expect(parseReviewsMetricsRoute("/metrics/unknown")).toBeNull();
  });
  it("renders Mine, read-only Person and authorized Everyone with exact JSON parity and ignores forged owner knobs", async () => {
    const handler = createReviewsMetricsViewHandler(scopedReader(), sendPage, { now: () => now });
    for (const [actor, total, owners] of [
      [selected("alice"), 2, ["access:alice"]],
      [person(), 3, ["access:bob"]],
      [selected("admin", "everyone"), 9, ["access:carol", "access:bob", "access:alice"]],
    ] as const) {
      const reports = [];
      for (const path of [
        "/metrics?all=1&requester=access:carol",
        "/metrics/health?person=access:carol",
        "/metrics.json?owner=access:carol",
      ]) {
        const req = invoke(handler, path, actor);
        await tick();
        expect(req.status).toBe(200);
        const report = path.startsWith("/metrics.json") ? JSON.parse(req.body()) : reviewSeed(req.body()).report;
        reports.push(report);
        expect(report.usage.runs).toBe(total);
        expect(report.usage.byRequester.map((row: { requester: string }) => row.requester)).toEqual(owners);
        if (!path.startsWith("/metrics.json")) expect(reviewSeed(req.body()).page).toBe("reviewsMetrics");
      }
      expect(reports[0]).toEqual(reports[1]);
      expect(reports[1]).toEqual(reports[2]);
    }
    const readonly = invoke(handler, "/metrics/health", person(), undefined, "POST");
    await tick();
    expect(readonly.status).toBe(405);
    expect(readonly.headers.allow).toBe("GET");
  });
  it("refuses missing, unknown, unscoped, denied and unauthorized Everyone callers before reading", async () => {
    const actor = selected("alice");
    const wide = withWorkViewScope({ ...actor }, { mode: "everyone", ownerIds: [], canEveryone: false });
    const invalid = withWorkViewScope(
      { ...actor, id: "unknown" },
      resolveWorkViewScope(actor, { organization: "installation" }),
    );
    const denied = withWorkViewScope(
      { ...actor, grants: NO_GRANTS },
      resolveWorkViewScope(actor, { organization: "installation" }),
    );
    const guarded: ReviewsService = {
      reviews: async () => {
        throw new Error("must not read");
      },
    };
    const handler = createReviewsMetricsViewHandler(guarded, sendPage, { now: () => now });
    for (const reader of [undefined, invalid, { ...actor }, denied, wide]) {
      const req = invoke(handler, "/metrics.json?all=1", reader);
      await tick();
      expect(req.status).toBe(403);
      expect(req.body()).toBe("review metrics not allowed");
    }
    const wrongCurrent = invoke(handler, "/metrics.json", actor, async () => selected("bob"));
    await tick();
    expect(wrongCurrent.status).toBe(403);
    const missing = fakeReqRes("GET", "/metrics.json");
    handler(missing.req, missing.res, { actor });
    await tick();
    expect(missing.status).toBe(403);
  });
  it("adds names only for returned requesters while the JSON twin remains the exact report", async () => {
    const actor = selected("alice");
    const handler = createReviewsMetricsViewHandler(scopedReader(), sendPage, {
      now: () => now,
      requesterNames: async () => ({ "access:alice": "Your account", "access:carol": "Other private person" }),
    });
    const page = invoke(handler, "/metrics", actor);
    await tick();
    expect(page.status).toBe(200);
    expect(reviewSeed(page.body()).requesterNames).toEqual({ "access:alice": "Your account" });
    expect(page.body()).not.toContain("Other private person");
    const json = invoke(handler, "/metrics.json", actor);
    await tick();
    expect(JSON.parse(json.body())).toEqual(reviewSeed(page.body()).report);
    expect(JSON.parse(json.body()).requesterNames).toBeUndefined();
  });
  it("keeps UTC ranges exact and refuses invalid dates before any reader call", async () => {
    const handler = createReviewsMetricsViewHandler(scopedReader(), sendPage, { now: () => now });
    const actor = selected("alice");
    const req = invoke(handler, "/metrics.json?from=1970-01-01&to=1970-01-07", actor);
    await tick();
    expect(req.status).toBe(200);
    expect(JSON.parse(req.body()).range).toEqual({
      fromMs: 0,
      toMs: 7 * DAY_MS,
      days: 7,
      bucket: "finish time",
      completeness: "at most once",
    });
    const forbidden = createReviewsMetricsViewHandler(
      {
        reviews: async () => {
          throw new Error("must not read");
        },
      },
      sendPage,
      { now: () => now },
    );
    for (const query of [
      "from=not-a-day",
      "from=1970-02-30",
      "from=1970-01-09&to=1970-01-01",
      "from=1970-01-01&to=1970-04-01",
      "from=1970-01-01&from=1970-01-02",
    ]) {
      const invalid = invoke(forbidden, `/metrics.json?${query}`, actor);
      await tick();
      expect(invalid.status).toBe(400);
      expect(invalid.body()).not.toContain("must not read");
    }
  });
  it("withholds finished reports after scope loss or native proof failure and hides provider details", async () => {
    const actor = selected("alice");
    let finish!: (value: Awaited<ReturnType<ReviewsService["reviews"]>>) => void;
    const pending: ReviewsService = {
      reviews: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    const handler = createReviewsMetricsViewHandler(pending, sendPage, { now: () => now });
    let current: Actor | undefined = actor;
    const req = invoke(handler, "/metrics", actor, async () => current);
    await tick();
    current = undefined;
    finish(
      await scopedReader().reviews({ fromMs: 0, toMs: DAY_MS }, { subject: actor.id, visibleTo: readableRuns(actor) }),
    );
    await tick();
    expect(req.status).toBe(403);
    expect(req.body()).toBe("review metrics access changed");
    expect(req.body()).not.toContain("access:alice");
    const changed = withWorkViewScope({ ...actor }, { mode: "mine", ownerIds: ["access:carol"], canEveryone: false });
    let first = true;
    const changedView = invoke(
      createReviewsMetricsViewHandler(scopedReader(), sendPage, { now: () => now }),
      "/metrics.json",
      actor,
      async () => {
        const next = first ? actor : changed;
        first = false;
        return next;
      },
    );
    await tick();
    expect(changedView.status).toBe(403);
    expect(changedView.body()).toBe("review metrics access changed");
    const off = invoke(
      createReviewsMetricsViewHandler(new NullReviewsService(), sendPage, { now: () => now }),
      "/metrics",
      actor,
    );
    await tick();
    expect(off.status).toBe(503);
    expect(off.body()).toBe(METRICS_OFF_MESSAGE);
    const outage = createReviewsMetricsViewHandler(
      {
        reviews: async () => {
          throw new MetricsSourceError(503, "private provider detail");
        },
      },
      sendPage,
      { now: () => now },
    );
    const failed = invoke(outage, "/metrics/health", actor);
    await tick();
    expect(failed.status).toBe(503);
    expect(failed.body()).toBe("review metrics unavailable: MetricsSourceError");
    const native = invoke(handler, "/metrics", actor, async () => {
      throw new Error("secret proof detail");
    });
    await tick();
    expect(native.status).toBe(503);
    expect(native.body()).toBe("review metrics unavailable: Error");
    let checks = 0;
    const finalOutage = invoke(
      createReviewsMetricsViewHandler(scopedReader(), sendPage, { now: () => now }),
      "/metrics.json",
      actor,
      async () => {
        if (++checks === 2) throw new Error("private final proof detail");
        return actor;
      },
    );
    await tick();
    expect(finalOutage.status).toBe(503);
    expect(finalOutage.body()).toBe("review metrics unavailable: Error");
  });
});
