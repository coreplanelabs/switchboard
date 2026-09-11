import { describe, expect, it } from "vitest";
import CostsPage from "./CostsPage.vue";
import { mountApp } from "../testing/mount";
import type { CostReport } from "@core/core/costs.js";
import type { CostsSeed } from "@core/channels/webSeed.js";

// Ported from the string-renderer suite (costsView.test.ts): the same page
// behaviors, against the mounted Vue page.

function report(over: Partial<CostReport> = {}): CostReport {
  const day = (date: string, bot: number, llm: number) => ({
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
    total: bot + 0.3 + llm,
  });
  const days = [day("2026-08-27", 0.3, 4), day("2026-08-28", 1.3, 12.5), day("2026-08-29", 0.9, 3)];
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

  it("leads with the summary tiles: yesterday (last FULL day), 7-day average, projected month, LLM share", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    const t = w.text();
    expect(t).toContain("Yesterday");
    expect(t).toContain("$14.10"); // 2026-08-28: 1.3 + 0.3 + 12.5 — not the partial day
    expect(t).toContain("2026-08-28 · last full day");
    expect(t).toContain("Projected month");
    expect(t).toContain("LLM share");
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
    const titles = w.findAll("rect.seg title").map((n) => n.text());
    expect(titles).toContain("2026-08-28 · Workers · storage · R2 · $0.05");
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

  it("draws one stacked bar per day as inline SVG with a title per segment (hover without JS)", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    const segs = w.findAll("rect.seg");
    expect(segs.length).toBeGreaterThanOrEqual(6); // 3 days × (bot + DO + LLM)
    const titles = w.findAll("rect.seg title").map((n) => n.text());
    expect(titles).toContain("2026-08-28 · bot · $1.30");
    expect(titles).toContain("2026-08-28 · LLM (Anthropic) · $12.50");
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
    expect(hrefs).toContain("/costs/switchboard?days=7");
    expect(hrefs).toContain("/costs/switchboard?days=90");
    expect(hrefs).not.toContain("/costs/switchboard?days=3");
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
