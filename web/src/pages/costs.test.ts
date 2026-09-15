import { describe, expect, it } from "vitest";
import CostsPage from "./CostsPage.vue";
import { mountApp } from "../testing/mount";
import type { CostReport } from "@core/core/costs.js";
import type { CostsSeed } from "@core/channels/webSeed.js";

// Ported from the string-renderer suite (costsView.test.ts): the same page
// behaviors, against the mounted Vue page.

function report(over: Partial<CostReport> = {}): CostReport {
  const day = (date: string, bot: number, llm: number, llmEstimated = false) => ({
    date,
    containers: { bot: { cpu: bot * 0.1, memory: bot * 0.8, disk: bot * 0.1, total: bot } },
    durableObjects: { "bot DO": 0.2 },
    doRequestsUsd: 0.05,
    doRowsUsd: 0.01,
    doStorageUsd: 0.01,
    workersUsd: 0.02,
    r2Usd: 0.01,
    workflowsUsd: 0,
    cloudUsd: bot + 0.3,
    llmUsd: llm,
    llmEstimated,
    llmUnpricedTokens: 0,
    total: bot + 0.3 + llm,
  });
  // The open day's LLM figure is the usage report at list, flagged as such.
  const days = [day("2026-08-27", 0.3, 4), day("2026-08-28", 1.3, 12.5), day("2026-08-29", 0.9, 3, true)];
  const cloudUsd = days.reduce((s, d) => s + d.cloudUsd, 0);
  return {
    group: "switchboard",
    label: "Switchboard <b>",
    range: { from: "2026-08-27", to: "2026-08-29", days: 3, partialLastDay: true },
    llmAvailable: true,
    days,
    totals: {
      cloudUsd,
      llmUsd: 19.5,
      total: days.reduce((s, d) => s + d.total, 0),
      byResource: {
        cpu: 0.25,
        memory: 2.0,
        disk: 0.25,
        durableObjects: 0.75,
        workers: 0.06,
        doRows: 0.03,
        doStorage: 0.03,
        r2: 0.03,
        workflows: 0,
      },
    },
    account: { cloudUsd: cloudUsd * 4 }, // three other tenants' worth on the same account
    attribution: {
      workers: ["switchboard", "switchboard-resident"],
      containerApps: { "app-bot": "bot" },
      durableObjectNamespaces: { "ns-bot": "bot DO", "ns-resident": "switchboard-resident" },
      r2Buckets: { "switchboard-resident-cache": "switchboard-resident-cache" },
      workflows: {},
    },
    ...over,
  };
}

const seed = (r: CostReport = report(), groups: string[] = ["switchboard", "other"]): CostsSeed => ({
  page: "costs",
  report: r,
  groups,
});

describe("CostsPage", () => {
  it("renders a hostile label as text, never as markup", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    expect(w.find("h1").text()).toContain("Switchboard <b> spend");
    expect(w.find("h1 b").exists()).toBe(false);
  });

  it("leads with the summary tiles: yesterday (last FULL day), 7-day average, projected month, LLM spend in dollars", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    const t = w.text();
    expect(t).toContain("Yesterday");
    expect(t).toContain("$14.10"); // 2026-08-28: 1.3 + 0.3 + 12.5 — not the partial day
    expect(t).toContain("2026-08-28 · last full day");
    expect(t).toContain("Projected month");
    // LLM spend will dwarf the Cloudflare spend, so a share of the total says
    // nothing: the tile is the dollars, with yesterday and the open day beneath.
    expect(t).toContain("LLM spend");
    expect(t).toContain("$19.50");
    expect(t).toContain("yesterday $12.50 · today $3.00 (estimate)");
    expect(t).not.toContain("LLM share");
  });

  it("with a one-day range the first tile is today so far, not an empty yesterday", () => {
    const r = report();
    const today = r.days[2];
    const w = mountApp(CostsPage, {
      seed: seed({
        ...r,
        range: { from: today.date, to: today.date, days: 1, partialLastDay: true },
        days: [today],
        totals: { ...r.totals, llmUsd: 3, total: today.total },
      }),
    });
    const t = w.text();
    expect(t).toContain("Today so far");
    expect(t).toContain("$4.20"); // 0.9 + 0.3 + 3
    expect(t).not.toContain("no full day in range");
  });

  it("lists the daily table newest first, the open day on top", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    const dates = w.findAll("table.data tbody td[title]").map((td) => td.attributes("title"));
    expect(dates).toEqual([...report().days].reverse().map((d) => d.date));
  });

  it("says which day's LLM figure is an estimate from the usage report", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    expect(w.find("table.data").text()).toContain("LLM estimated");
    expect(w.text()).toContain("usage report");
  });

  it("says what share of the account's whole Cloudflare spend this group is, and what was attributed to it", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    const t = w.text();
    expect(t).toContain("Share of account");
    expect(t).toContain("25%"); // the group is a quarter of the account
    expect(t).toContain("$3.40 of $13.60 Cloudflare spend in range");
    expect(t).toContain("switchboard, switchboard-resident");
    expect(t).toMatch(/namespace they host \(2\)/);
    expect(t).toMatch(/named after them \(1\)/);
  });

  it("stacks the small platform meters (Workers, SQLite rows and storage, R2) as one series and lists each in the split", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    expect(w.find(".legend").text()).toContain("Workers · storage · R2");
    const fullDay = report().days[1].date;
    const dayTitle = w
      .findAll("rect.day title")
      .map((n) => n.text())
      .find((t) => t.startsWith(fullDay));
    expect(dayTitle).toContain("Workers · storage · R2 $0.05");
    const t = w.text();
    for (const row of [
      "Workers requests + CPU",
      "Durable Object SQLite rows",
      "Durable Object SQLite storage",
      "R2 storage + operations",
      "Workflow steps + state",
    ])
      expect(t).toContain(row);
  });

  it("draws one stacked bar per day as inline SVG, one rect per day × component, with no per-segment tooltip competing with the day's", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    const segs = w.findAll("rect.seg");
    expect(segs.length).toBeGreaterThanOrEqual(6); // 3 days × (bot + DO + LLM)
    expect(w.findAll("rect.seg title").length).toBe(0);
  });

  it("one hover target per day carries the whole day's breakdown — every series and the total", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    const days = w.findAll("rect.day");
    expect(days.length).toBe(3);
    const titles = w.findAll("rect.day title").map((n) => n.text());
    const [, fullDay, openDay] = report().days;
    const aug28 = titles.find((t) => t.startsWith(fullDay.date));
    expect(aug28).toBeDefined();
    expect(aug28).toContain("total $14.10");
    expect(aug28).toContain("bot $1.30");
    expect(aug28).toContain("Durable Objects $0.25");
    expect(aug28).toContain("LLM (Anthropic) $12.50");
    expect(titles.find((t) => t.startsWith(openDay.date))).toContain("estimate");
  });

  it("includes a legend and a table view so identity is never color-alone; dates read human with the ISO on hover", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    expect(w.find(".legend").text()).toContain("LLM (Anthropic)");
    expect(w.find("table.data").exists()).toBe(true);
    expect(w.find("table.data").text()).toContain("Aug 27");
    expect(w.find('table.data td[title="2026-08-27"]').exists()).toBe(true);
  });

  it("marks the partial day and states the method", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    expect(w.text()).toContain("partial day");
    expect(w.text()).toMatch(/vCPU[^<]*active use/i);
    expect(w.text()).toContain("containersUsageAdaptiveGroups");
  });

  it("carries the shared site nav with Costs current", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    expect(w.find('nav.site a[aria-current="page"]').attributes("href")).toBe("/costs");
  });

  it("offers the range switch with the current range as text, the others as links", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    const hrefs = w.findAll("a").map((a) => a.attributes("href"));
    expect(hrefs).toContain("/costs/switchboard?days=1");
    expect(hrefs).toContain("/costs/switchboard?days=7");
    expect(hrefs).toContain("/costs/switchboard?days=90");
    expect(hrefs).not.toContain("/costs/switchboard?days=3");
    // A visible switcher beside the group pills, not header small print; the
    // short preset is today (UTC), never a rolling window the sources lack.
    expect(w.find('nav[aria-label="Range"]').exists()).toBe(true);
    expect(w.find('nav[aria-label="Range"]').text()).toContain("today");
    expect(w.find('nav[aria-label="Range"]').text()).not.toContain("24h");
  });

  it("links sibling groups when more than one is configured", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    expect(w.findAll("a").map((a) => a.attributes("href"))).toContain("/costs/other");
    const single = mountApp(CostsPage, { seed: seed(report(), ["switchboard"]) });
    expect(single.findAll("a").map((a) => a.attributes("href"))).not.toContain("/costs/other");
  });

  it("says LLM spend is not configured instead of showing $0 when there is no source", () => {
    const r = report({ llmAvailable: false, totals: { ...report().totals, llmUsd: 0 } });
    const w = mountApp(CostsPage, { seed: seed(r, ["switchboard"]) });
    expect(w.text()).toContain("LLM spend not configured");
  });

  it("names the JSON twin", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    expect(w.text()).toContain("GET /costs/switchboard.json");
  });
});
