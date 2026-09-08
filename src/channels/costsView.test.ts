import { describe, expect, it } from "vitest";
import type { CostReport, CostsService } from "../core/costs.js";
import { createCostsViewHandler, parseCostsRoute } from "./costsView.js";
import { makeShellRenderer } from "./webShell.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import { SEED_ELEMENT_ID, type CostsSeed } from "./webSeed.js";

// The costs dash handler: routing, live-per-request reads, error statuses,
// the JSON twin, and the seed the shell carries. Rendering is tested in
// web/src/pages/costs.test.ts.

// ---- fixtures ---------------------------------------------------------------

function report(over: Partial<CostReport> = {}): CostReport {
  const day = (date: string, bot: number, llm: number) => ({
    date,
    containers: { bot: { cpu: bot * 0.1, memory: bot * 0.8, disk: bot * 0.1, total: bot } },
    durableObjects: { "bot DO": 0.2 },
    doRequestsUsd: 0.05,
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

const shell = makeShellRenderer({ js: "/assets/main-test.js", css: [] }, ALL_CAPABILITIES);

function seedOf(html: string): CostsSeed {
  const m = new RegExp(`<script type="application/json" id="${SEED_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
  if (!m) throw new Error("no seed island in the page");
  return JSON.parse(m[1]) as CostsSeed;
}

function fakeService(
  impl: (group: string, days: string | null) => Promise<CostReport>,
  groups = ["switchboard"],
): CostsService {
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

// ---- handler ----------------------------------------------------------------------

describe("createCostsViewHandler", () => {
  it("ignores paths it does not own", () => {
    const h = createCostsViewHandler(
      fakeService(() => Promise.resolve(report())),
      shell,
    );
    const io = fakeReqRes("GET", "/runs");
    expect(h(io.req, io.res)).toBe(false);
    expect(io.status).toBe(0);
  });

  it("503s with a pointer to the config when no service is wired", () => {
    const h = createCostsViewHandler(undefined, shell);
    const io = fakeReqRes("GET", "/costs");
    expect(h(io.req, io.res)).toBe(true);
    expect(io.status).toBe(503);
    expect(io.body()).toContain("costs.cloudflareAccountId");
    expect(io.body()).toContain("CF_ANALYTICS_TOKEN");
  });

  it("405s non-GET", () => {
    const h = createCostsViewHandler(
      fakeService(() => Promise.resolve(report())),
      shell,
    );
    const io = fakeReqRes("POST", "/costs");
    expect(h(io.req, io.res)).toBe(true);
    expect(io.status).toBe(405);
    expect(io.headers.allow).toBe("GET");
  });

  it("serves the first group on the bare index, LIVE per request, with the hardened page headers and the report + groups as the seed", async () => {
    let calls = 0;
    const h = createCostsViewHandler(
      fakeService(
        (group, days) => {
          calls++;
          expect(group).toBe("switchboard");
          expect(days).toBeNull();
          return Promise.resolve(report());
        },
        ["switchboard", "other"],
      ),
      shell,
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
      const seed = seedOf(io.body());
      expect(seed.page).toBe("costs");
      expect(seed.report).toEqual(report());
      expect(seed.groups).toEqual(["switchboard", "other"]);
      // the title interpolation escapes the hostile label; the seed keeps it as data
      expect(io.body()).toContain("<title>Switchboard &lt;b&gt; spend</title>");
      expect(io.body()).not.toContain("<title>Switchboard <b>");
    }
    expect(calls).toBe(2);
  });

  it("passes ?days through and 404s an unknown group", async () => {
    const h = createCostsViewHandler(
      fakeService((_g, days) =>
        Promise.resolve(report({ range: { from: "x", to: "y", days: Number(days), partialLastDay: false } })),
      ),
      shell,
    );
    const ok = fakeReqRes("GET", "/costs/switchboard?days=7");
    h(ok.req, ok.res);
    await tick();
    expect(ok.status).toBe(200);
    expect(seedOf(ok.body()).report.range.days).toBe(7);

    const miss = fakeReqRes("GET", "/costs/nope");
    expect(h(miss.req, miss.res)).toBe(true);
    expect(miss.status).toBe(404);
  });

  it("serves the JSON twin for agents with no-store", async () => {
    const h = createCostsViewHandler(
      fakeService(() => Promise.resolve(report())),
      shell,
    );
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
    const h = createCostsViewHandler(
      fakeService(() => Promise.reject(new Error("cloudflare graphql 403: denied " + "x".repeat(2000)))),
      shell,
    );
    const io = fakeReqRes("GET", "/costs");
    h(io.req, io.res);
    await tick();
    expect(io.status).toBe(502);
    expect(io.body()).toContain("cloudflare graphql 403");
    expect(io.body().length).toBeLessThan(600);
  });
});
