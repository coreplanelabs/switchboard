import { describe, expect, it } from "vitest";
import type { CostReport, CostsService } from "../core/costs.js";
import { createCostsViewHandler, parseCostsRoute, renderCostsPage } from "./costsView.js";

// ---- fixtures ---------------------------------------------------------------

function report(over: Partial<CostReport> = {}): CostReport {
  const day = (date: string, bot: number, llm: number) => ({
    date,
    containers: { bot: { cpu: bot * 0.1, memory: bot * 0.8, disk: bot * 0.1, total: bot } },
    durableObjects: { switchboard: 0.25 },
    cloudUsd: bot + 0.25,
    llmUsd: llm,
    total: bot + 0.25 + llm,
  });
  const days = [day("2026-08-27", 0.3, 4), day("2026-08-28", 1.3, 12.5), day("2026-08-29", 0.9, 3)];
  return {
    group: "switchboard",
    label: "Switchboard <b>",
    range: { from: "2026-08-27", to: "2026-08-29", days: 3, partialLastDay: true },
    llmAvailable: true,
    days,
    totals: {
      cloudUsd: days.reduce((s, d) => s + d.cloudUsd, 0),
      llmUsd: 19.5,
      total: days.reduce((s, d) => s + d.total, 0),
      byResource: { cpu: 0.25, memory: 2.0, disk: 0.25, durableObjects: 0.75 },
    },
    ...over,
  };
}

function fakeService(impl: (group: string, days: string | null) => Promise<CostReport>, groups = ["switchboard"]): CostsService {
  return { groups: () => groups, report: impl };
}

function fakeReqRes(method: string, url: string) {
  let status = 0;
  let outHeaders: Record<string, string> = {};
  const chunks: string[] = [];
  const req = { method, url, headers: {}, on: () => undefined };
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
    req: req as unknown as Parameters<ReturnType<typeof createCostsViewHandler>>[0],
    res: res as unknown as Parameters<ReturnType<typeof createCostsViewHandler>>[1],
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

describe("parseCostsRoute", () => {
  it("matches the bare index, a group page, and a group's JSON twin", () => {
    expect(parseCostsRoute("/costs")).toEqual({ kind: "page", group: null });
    expect(parseCostsRoute("/costs/")).toEqual({ kind: "page", group: null });
    expect(parseCostsRoute("/costs/switchboard")).toEqual({ kind: "page", group: "switchboard" });
    expect(parseCostsRoute("/costs/switchboard.json")).toEqual({ kind: "json", group: "switchboard" });
    expect(parseCostsRoute("/costs.json")).toEqual({ kind: "json", group: null });
  });
  it("rejects anything else, including traversal-shaped and over-long slugs", () => {
    expect(parseCostsRoute("/costsX")).toBeNull();
    expect(parseCostsRoute("/costs/a/b")).toBeNull();
    expect(parseCostsRoute("/costs/../x")).toBeNull();
    expect(parseCostsRoute("/costs/" + "a".repeat(80))).toBeNull();
    expect(parseCostsRoute("/runs")).toBeNull();
  });
});

// ---- rendering ----------------------------------------------------------------

describe("renderCostsPage", () => {
  const html = renderCostsPage(report(), ["switchboard", "other"]);

  it("is a self-contained page that escapes every dynamic string", () => {
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Switchboard &lt;b&gt;");
    expect(html).not.toContain("Switchboard <b>");
    expect(html).not.toMatch(/<script/i); // pure server render — nothing to run under the CSP
    expect(html).not.toContain("http://"); // no external assets
  });

  it("leads with the summary tiles: yesterday, 7-day average, projected month", () => {
    expect(html).toContain("Yesterday");
    expect(html).toContain("$14.05"); // 2026-08-28: 1.3 + 0.25 + 12.5 — the last FULL day, not the partial one
    expect(html).toContain("Projected month");
  });

  it("draws one stacked bar per day as inline SVG with a title per segment (hover without JS)", () => {
    expect(html.match(/<rect class="seg/g)?.length).toBeGreaterThanOrEqual(6); // 3 days × (bot + DO + LLM)
    expect(html).toContain("<title>2026-08-28 · bot · $1.30</title>");
    expect(html).toContain("<title>2026-08-28 · LLM (Anthropic) · $12.50</title>");
  });

  it("includes a legend and a table view so identity is never color-alone", () => {
    expect(html).toContain('class="legend"');
    expect(html).toMatch(/<table[^>]*class="data"/);
    expect(html).toContain("2026-08-27");
  });

  it("marks the partial day and states the method", () => {
    expect(html).toContain("partial day");
    expect(html).toMatch(/vCPU[^<]*active use/i);
    expect(html).toContain("containersUsageAdaptiveGroups");
  });

  it("carries the shared site nav with Costs current and no duplicate cross-links", () => {
    expect(html).toContain('<nav class="site" aria-label="Sections">');
    expect(html).toContain('<a href="/costs" aria-current="page">Costs</a>');
    expect(html.match(/href="\/residents"/g)?.length).toBe(1);
    expect(html.match(/href="\/runs"/g)?.length).toBe(1);
  });

  it("links sibling groups when more than one is configured", () => {
    expect(html).toContain('href="/costs/other"');
    expect(renderCostsPage(report(), ["switchboard"])).not.toContain('href="/costs/other"');
  });

  it("says LLM spend is not configured instead of showing $0 when there is no source", () => {
    const h = renderCostsPage(report({ llmAvailable: false, totals: { ...report().totals, llmUsd: 0 } }), ["switchboard"]);
    expect(h).toContain("LLM spend not configured");
  });
});

// ---- handler ----------------------------------------------------------------------

describe("createCostsViewHandler", () => {
  it("ignores paths it does not own", () => {
    const h = createCostsViewHandler(fakeService(() => Promise.resolve(report())));
    const io = fakeReqRes("GET", "/runs");
    expect(h(io.req, io.res)).toBe(false);
    expect(io.status).toBe(0);
  });

  it("503s with a pointer to the config when no service is wired", () => {
    const h = createCostsViewHandler(undefined);
    const io = fakeReqRes("GET", "/costs");
    expect(h(io.req, io.res)).toBe(true);
    expect(io.status).toBe(503);
    expect(io.body()).toContain("costs.cloudflareAccountId");
    expect(io.body()).toContain("CF_ANALYTICS_TOKEN");
  });

  it("405s non-GET", () => {
    const h = createCostsViewHandler(fakeService(() => Promise.resolve(report())));
    const io = fakeReqRes("POST", "/costs");
    expect(h(io.req, io.res)).toBe(true);
    expect(io.status).toBe(405);
    expect(io.headers.allow).toBe("GET");
  });

  it("serves the first group on the bare index, LIVE per request, with the hardened page headers", async () => {
    let calls = 0;
    const h = createCostsViewHandler(
      fakeService((group, days) => {
        calls++;
        expect(group).toBe("switchboard");
        expect(days).toBeNull();
        return Promise.resolve(report());
      }),
    );
    for (let i = 0; i < 2; i++) {
      const io = fakeReqRes("GET", "/costs");
      expect(h(io.req, io.res)).toBe(true);
      await tick();
      expect(io.status).toBe(200);
      expect(io.headers["content-type"]).toContain("text/html");
      expect(io.headers["cache-control"]).toBe("no-store");
      expect(io.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(io.headers["x-frame-options"]).toBe("DENY");
      expect(io.body()).toContain("Switchboard");
    }
    expect(calls).toBe(2);
  });

  it("passes ?days through and 404s an unknown group", async () => {
    const h = createCostsViewHandler(fakeService((_g, days) => Promise.resolve(report({ range: { from: "x", to: "y", days: Number(days), partialLastDay: false } }))));
    const ok = fakeReqRes("GET", "/costs/switchboard?days=7");
    h(ok.req, ok.res);
    await tick();
    expect(ok.status).toBe(200);
    expect(ok.body()).toContain("7 days");

    const miss = fakeReqRes("GET", "/costs/nope");
    expect(h(miss.req, miss.res)).toBe(true);
    expect(miss.status).toBe(404);
  });

  it("serves the JSON twin for agents with no-store", async () => {
    const h = createCostsViewHandler(fakeService(() => Promise.resolve(report())));
    const io = fakeReqRes("GET", "/costs/switchboard.json");
    h(io.req, io.res);
    await tick();
    expect(io.status).toBe(200);
    expect(io.headers["content-type"]).toContain("application/json");
    expect(io.headers["cache-control"]).toBe("no-store");
    const parsed = JSON.parse(io.body()) as CostReport;
    expect(parsed.group).toBe("switchboard");
    expect(parsed.days).toHaveLength(3);
  });

  it("502s (never 500s, never leaks) when an upstream source fails", async () => {
    const h = createCostsViewHandler(fakeService(() => Promise.reject(new Error("cloudflare graphql 403: denied " + "x".repeat(2000)))));
    const io = fakeReqRes("GET", "/costs");
    h(io.req, io.res);
    await tick();
    expect(io.status).toBe(502);
    expect(io.body()).toContain("cloudflare graphql 403");
    expect(io.body().length).toBeLessThan(600);
  });
});
