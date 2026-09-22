import { describe, expect, it, vi } from "vitest";
import { DAY_MS } from "../core/budgets.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import { buildMetricsReport, MetricsSourceError, type MetricsReport } from "../core/metrics.js";
import { METRICS_OFF_MESSAGE, NullMetricsService, type MetricsService } from "../core/metricsService.js";
import { createMetricsViewHandler, parseMetricsRoute } from "./metricsView.js";
import { SEED_ELEMENT_ID, type MetricsSeed } from "./webSeed.js";
import { makePageSender } from "./webShell.js";

// The metrics page handler (run-metrics.md item 10): routing, the seed the
// shell carries, the JSON twin, the query knobs, and the off/error statuses.
// Rendering is tested in web/src/pages/metrics.test.ts.

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
  return { report: vi.fn(impl) } as MetricsService & { report: ReturnType<typeof vi.fn> };
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
    expect(page.body()).toContain("<title>Run metrics</title>");
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
    expect(service.report).toHaveBeenCalledWith({ days: 7, agent: "coding" });
    const bare = fakeReqRes("GET", "/metrics");
    handler(bare.req, bare.res);
    await tick();
    expect(service.report).toHaveBeenLastCalledWith({});
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
    expect(t.body()).toBe("run metrics unavailable: MetricsSourceError");
    expect(t.body()).not.toContain("secret-words");
  });
});
