import { describe, expect, it } from "vitest";
import CostsPage from "./CostsPage.vue";
import { mountApp } from "../testing/mount";
import type { CostReport } from "@core/core/costs.js";
import type { UserCostReport } from "@core/core/costsByUser.js";
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
    // The page is rendered at 12:00Z on the open day: half of it has elapsed.
    generatedAt: Date.parse("2026-08-29T12:00:00Z"),
    account: { id: "acct-example", name: "acme-infra", cloudUsd: cloudUsd * 4 }, // three other tenants' worth on the same account
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
  view: "daily",
});

/** The by-user report for the same three days: two Slack users, one of them the
 *  signed-in viewer; a day's cloud split by wall-clock, the LLM at list. */
function usersReport(over: Partial<UserCostReport> = {}): UserCostReport {
  const r = report();
  const alice = {
    userId: "slack:U0AL1CE",
    userName: "alice",
    runs: 7,
    wallMs: 3_600_000,
    llmUsd: 12.25,
    cloudUsd: 1.5,
    totalUsd: 13.75,
    unpricedTokens: 0,
    byModel: {},
  };
  const bob = {
    userId: "slack:U0B0B",
    userName: "bob",
    runs: 2,
    wallMs: 1_200_000,
    llmUsd: 3.5,
    cloudUsd: 0.5,
    totalUsd: 4.0,
    unpricedTokens: 1200,
    byModel: {},
  };
  return {
    group: r.group,
    range: r.range,
    coverage: { from: r.range.from, retentionDays: 30, clamped: false, historyOn: true },
    users: [alice, bob],
    days: [],
    pending: 0,
    reconciliation: {
      attributedLlmUsd: 15.75,
      workspaceLlmUsd: 19.5,
      unattributedLlmUsd: 3.75,
      comparedDays: 3,
      uncomparedDays: 0,
      uncomparedLlmUsd: 0,
      cloudAllocatedUsd: 2.0,
      cloudUnallocatedUsd: 1.4,
    },
    viewer: { userIds: ["slack:U0B0B"], matchedByEmail: true },
    generatedAt: r.generatedAt,
    ...over,
  };
}

/** `null`: the page was served without its by-user report. */
const usersSeed = (users: UserCostReport | null = usersReport()): CostsSeed => ({
  ...seed(),
  view: "users",
  ...(users ? { users } : {}),
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

  it("projects the month from cloud and LLM run-rates added together, and says what each is based on", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    const t = w.text();
    // Cloud: the two full days average (0.6 + 1.6) / 2 = $1.10 a day. LLM: the
    // two closed days with LLM data average (4 + 12.5) / 2 = $8.25 a day.
    // (1.10 + 8.25) × 30.4 = $284.
    expect(t).toContain("Projected month");
    expect(t).toContain("$284");
    expect(t).toContain("cloud $1.10/day + LLM $8.25/day");
    expect(t).toContain("LLM from 2 closed days");
  });

  it("with no closed LLM day yet, the LLM run-rate is today's estimate scaled to a full day", () => {
    const r = report();
    const days = r.days.map((d, i) => (i < 2 ? { ...d, llmUsd: 0, total: d.cloudUsd } : d));
    const w = mountApp(CostsPage, {
      seed: seed({ ...r, days, totals: { ...r.totals, llmUsd: 3, total: days.reduce((s, d) => s + d.total, 0) } }),
    });
    const t = w.text();
    // Today: $3 of LLM at 12:00Z → $6.00 a day. Cloud stays the full-day average $1.10.
    // (1.10 + 6.00) × 30.4 = $216.
    expect(t).toContain("$216");
    expect(t).toContain("cloud $1.10/day + LLM $6.00/day");
    expect(t).toContain("LLM from today so far");
  });

  it("names the Cloudflare account and links every figure to where it can be dug into", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    const hrefs = w.findAll("a").map((a) => a.attributes("href") ?? "");
    expect(w.text()).toContain("acme-infra");
    expect(hrefs).toContain("https://dash.cloudflare.com/acct-example");
    expect(hrefs).toContain("https://dash.cloudflare.com/acct-example/billing");
    expect(hrefs).toContain("https://dash.cloudflare.com/acct-example/workers/containers");
    expect(hrefs).toContain("https://dash.cloudflare.com/acct-example/workers/durable-objects");
    expect(hrefs).toContain("https://dash.cloudflare.com/acct-example/r2/default/buckets/switchboard-resident-cache");
    expect(hrefs).toContain(
      "https://dash.cloudflare.com/acct-example/workers/services/view/switchboard-resident/production/metrics",
    );
    expect(hrefs).toContain("https://platform.claude.com/cost");
    // External links open in a new tab without handing the opener over.
    const ext = w.findAll('a[href^="https://dash.cloudflare.com"]');
    expect(ext.length).toBeGreaterThan(0);
    for (const a of ext) expect(a.attributes("rel")).toContain("noopener");
  });

  it("falls back to the account id when no account name is configured", () => {
    const r = report();
    const w = mountApp(CostsPage, { seed: seed({ ...r, account: { ...r.account, name: undefined } }) });
    expect(w.text()).toContain("acct-exa…");
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
    // No full day: the average tile says so instead of $0.00, and the projection
    // runs on today scaled: cloud 1.20/0.5 = 2.40, LLM 3/0.5 = 6.00 → 8.40 × 30.4 = $255.
    expect(t).toContain("no full day yet");
    expect(t).not.toContain("per day, full days only");
    expect(t).toContain("$255");
    expect(t).toContain("cloud $2.40/day + LLM $6.00/day");
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
    expect(t).toContain("$3.40 of $13.60 on acme-infra");
    expect(t).toContain("switchboard, switchboard-resident");
    expect(t).toMatch(/namespace they host \(2\)/);
    expect(t).toMatch(/named after them \(switchboard-resident-cache\)/);
  });

  it("stacks the small platform meters (Workers, SQLite rows and storage, R2) as one series and lists each in the split", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    expect(w.find(".legend").text()).toContain("Workers · storage · R2");
    const fullDay = report().days[1].date;
    const dayTitle = w
      .findAll("rect.day")
      .map((n) => n.attributes("aria-label") ?? "")
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

  it("one hover target per day carries the whole day's breakdown — every series and the total — as its accessible label", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    const days = w.findAll("rect.day");
    expect(days.length).toBe(3);
    const labels = days.map((n) => n.attributes("aria-label") ?? "");
    const [, fullDay, openDay] = report().days;
    const aug28 = labels.find((t) => t.startsWith(fullDay.date));
    expect(aug28).toBeDefined();
    expect(aug28).toContain("total $14.10");
    expect(aug28).toContain("bot $1.30");
    expect(aug28).toContain("Durable Objects $0.25");
    expect(aug28).toContain("LLM (Anthropic) $12.50");
    expect(labels.find((t) => t.startsWith(openDay.date))).toContain("estimate");
    // No native <title>: the tooltip below is the one that shows, without the browser's delay.
    expect(w.findAll("rect.day title").length).toBe(0);
  });

  it("hovering a day shows a compact tooltip: the day and its total on top, then one row per component, largest first, the estimate tagged; leaving hides it", async () => {
    const w = mountApp(CostsPage, { seed: seed() });
    expect(w.find(".chart-tip").exists()).toBe(false);
    const [, , openDay] = w.findAll("rect.day");
    await openDay.trigger("pointerenter", { clientX: 300, clientY: 120 });
    const tip = w.find(".chart-tip");
    expect(tip.exists()).toBe(true);
    expect(tip.attributes("role")).toBe("tooltip");
    // Header: a human date and the partial-day marker, the total on the right.
    const head = tip.find(".tip-head");
    expect(head.text()).toContain("Aug 29");
    expect(head.text()).toContain("partial day");
    expect(head.text()).toContain("$4.20");
    expect(head.text()).not.toContain("total"); // the number speaks; no label prose
    // Rows: series → dollars, sorted by size, zero components omitted, the estimate tagged short.
    const rows = tip.findAll(".tip-row");
    expect(rows.map((r) => r.find(".tip-name").text())).toEqual([
      "LLM (Anthropic)",
      "bot",
      "Durable Objects",
      "Workers · storage · R2",
    ]);
    expect(rows[0].find(".tip-usd").text()).toBe("$3.00");
    expect(rows[0].text()).toContain("est.");
    expect(rows[1].text()).not.toContain("est.");
    await openDay.trigger("pointerleave");
    expect(w.find(".chart-tip").exists()).toBe(false);
  });

  it("the tooltip lives outside the chart's scroll box, has a fixed width, and flips to the left near the right edge instead of growing the card", async () => {
    const w = mountApp(CostsPage, { seed: seed() });
    const host = w.find(".chart-host");
    // The scroll box is a child of the host; the tip is the host's child, never the scroll box's.
    Object.defineProperty(host.element, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(host.element, "clientHeight", { value: 300, configurable: true });
    const [first, , last] = w.findAll("rect.day");
    await first.trigger("pointerenter", { clientX: 100, clientY: 40 });
    let tip = w.find(".chart-tip");
    expect(tip.element.parentElement).toBe(host.element);
    expect(tip.element.parentElement?.classList.contains("overflow-x-auto")).toBe(false);
    expect(tip.classes().some((c) => /^w-/.test(c))).toBe(true);
    expect(tip.classes()).toContain("whitespace-nowrap");
    expect(parseFloat((tip.attributes("style") ?? "").match(/left:\s*([\d.]+)px/)?.[1] ?? "NaN")).toBeGreaterThan(100);
    await first.trigger("pointerleave");
    // Near the right edge the panel opens to the left of the pointer; near the bottom, above it.
    await last.trigger("pointerenter", { clientX: 780, clientY: 290 });
    tip = w.find(".chart-tip");
    const left = parseFloat((tip.attributes("style") ?? "").match(/left:\s*([\d.]+)px/)?.[1] ?? "NaN");
    const top = parseFloat((tip.attributes("style") ?? "").match(/top:\s*([\d.]+)px/)?.[1] ?? "NaN");
    expect(left).toBeLessThan(780 - 200);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(290);
    expect(top).toBeGreaterThanOrEqual(0);
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
    // A sibling opens on the same range (and, below, the same tab).
    expect(w.findAll("a").map((a) => a.attributes("href"))).toContain("/costs/other?days=3");
    const single = mountApp(CostsPage, { seed: seed(report(), ["switchboard"]) });
    expect(single.findAll("a").some((a) => (a.attributes("href") ?? "").startsWith("/costs/other"))).toBe(false);
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

  it("offers Daily and By user as tabs above the tables; the daily tab shows the daily tables and no user table", () => {
    const w = mountApp(CostsPage, { seed: seed() });
    const tabs = w.find('nav[aria-label="View"]');
    expect(tabs.exists()).toBe(true);
    expect(tabs.find('[aria-current="page"]').text()).toBe("Daily");
    expect(tabs.find("a").attributes("href")).toBe("/costs/switchboard?days=3&view=users");
    expect(w.find("table.data").exists()).toBe(true);
    expect(w.find("table.users").exists()).toBe(false);
  });
});

describe("CostsPage · By user", () => {
  it("lists one row per user largest first — name, runs, LLM, allocated cloud, total, share of what was attributed — and marks the viewer's row", () => {
    const w = mountApp(CostsPage, { seed: usersSeed() });
    expect(w.find('nav[aria-label="View"] [aria-current="page"]').text()).toBe("By user");
    // The daily tables step aside; the tiles and the chart stay as the group's context.
    expect(w.find("table.data").exists()).toBe(false);
    expect(w.find("rect.day").exists()).toBe(true);
    const rows = w.findAll("table.users tbody tr.user-row");
    expect(rows.length).toBe(2);
    expect(rows[0].text()).toContain("alice");
    expect(rows[0].findAll("td").map((td) => td.text())).toEqual(
      expect.arrayContaining(["7", "$12.25", "$1.50", "$13.75", "77%"]),
    );
    expect(rows[1].text()).toContain("bob");
    expect(rows[1].classes()).toContain("is-me");
    expect(rows[1].text()).toContain("me");
    expect(rows[0].classes()).not.toContain("is-me");
    // The id stays reachable on hover; the platform prefix is not the name.
    expect(rows[0].find("td[title]").attributes("title")).toBe("slack:U0AL1CE");
    expect(w.find("table.users thead").text()).toContain("allocated");
    // Tokens under a model with no list price are said, not $0 in silence.
    expect(rows[1].text()).toContain("unpriced tokens");
    expect(rows[0].text()).not.toContain("unpriced tokens");
  });

  it("filters by name or id, and the me toggle keeps only the signed-in viewer's rows; the shown subtotal appears when rows are hidden", async () => {
    const w = mountApp(CostsPage, { seed: usersSeed() });
    await w.find("input.user-filter").setValue("ali");
    let rows = w.findAll("table.users tbody tr.user-row");
    expect(rows.map((r) => r.find("td").text())).toEqual([expect.stringContaining("alice")]);
    expect(w.find("table.users tfoot").text()).toContain("shown");
    expect(w.find("table.users tfoot").text()).toContain("$13.75");
    await w.find("input.user-filter").setValue("U0B0B");
    rows = w.findAll("table.users tbody tr.user-row");
    expect(rows.map((r) => r.find("td").text())).toEqual([expect.stringContaining("bob")]);
    await w.find("input.user-filter").setValue("nobody");
    expect(w.find("table.users td.empty").text()).toBe("no user matches");
    await w.find("input.user-filter").setValue("");
    expect(w.find("table.users tfoot").exists()).toBe(false);
    const me = w.find(".me-toggle input");
    expect(me.attributes("disabled")).toBeUndefined();
    await me.setValue(true);
    rows = w.findAll("table.users tbody tr.user-row");
    expect(rows.length).toBe(1);
    expect(rows[0].text()).toContain("bob");
  });

  it("disables the me toggle, and says why in visible text the input describes, when the viewer matched no run user", () => {
    const w = mountApp(CostsPage, { seed: usersSeed(usersReport({ viewer: { userIds: [], matchedByEmail: false } })) });
    const input = w.find(".me-toggle input");
    expect(input.attributes("disabled")).toBeDefined();
    // The reason is on the page, not in a hover-only title, and the input points at it.
    const hint = w.find(".me-toggle .me-hint");
    expect(hint.text()).toContain("matched no Slack user");
    expect(input.attributes("aria-describedby")).toBe(hint.attributes("id"));
    expect(w.find(".me-toggle").attributes("title")).toBeUndefined();
    expect(w.findAll("tr.is-me").length).toBe(0);
    // With a match the hint is gone and the toggle is live.
    const on = mountApp(CostsPage, { seed: usersSeed() });
    expect(on.find(".me-toggle .me-hint").exists()).toBe(false);
    expect(on.find(".me-toggle input").attributes("aria-describedby")).toBeUndefined();
  });

  it("states the coverage plainly: where the data begins, a clamped range, runs still being priced; and with history off, that there is nothing to attribute", () => {
    const w = mountApp(CostsPage, { seed: usersSeed() });
    expect(w.find(".coverage").text()).toBe("runs from Aug 27 to Aug 29");
    const clamped = mountApp(CostsPage, {
      seed: usersSeed(
        usersReport({
          coverage: { from: report().days[1].date, retentionDays: 30, clamped: true, historyOn: true },
          pending: 3,
        }),
      ),
    });
    const t = clamped.find(".coverage").text();
    expect(t).toContain("runs from Aug 28 to Aug 29");
    expect(t).toContain("past the history's 30-day window");
    expect(t).toContain("3 runs still being priced");
    const off = mountApp(CostsPage, {
      seed: usersSeed(
        usersReport({
          coverage: { from: report().days[2].date, retentionDays: 0, clamped: true, historyOn: false },
          users: [],
          viewer: { userIds: [], matchedByEmail: false },
        }),
      ),
    });
    expect(off.find(".coverage").text()).toContain("run history is off");
    expect(off.find("table.users td.empty").text()).toBe("no runs in this range");
  });

  it("carries one reconciliation line: attributed LLM against the workspace figure, the unattributed remainder, cloud allocated and unallocated", () => {
    const w = mountApp(CostsPage, { seed: usersSeed() });
    const line = w.find(".reconciliation").text().replace(/\s+/g, " ");
    expect(line).toContain("LLM attributed $15.75 of $19.50 on the workspace over 3 days");
    expect(line).toContain("$3.75 unattributed");
    expect(line).not.toContain("not compared");
    expect(line).toContain("cloud allocated $2.00");
    expect(line).toContain("$1.40 on days with no runs");
    const tidy = mountApp(CostsPage, {
      seed: usersSeed(usersReport({ reconciliation: { ...usersReport().reconciliation, cloudUnallocatedUsd: 0 } })),
    });
    expect(tidy.find(".reconciliation").text()).not.toContain("days with no runs");
  });

  it("days whose runs spent tokens against a zero workspace figure are named apart from the tie-out, and a range with no figure at all says so instead of comparing", () => {
    const rec = usersReport().reconciliation;
    const partly = mountApp(CostsPage, {
      seed: usersSeed(
        usersReport({
          reconciliation: {
            ...rec,
            attributedLlmUsd: 3.5,
            workspaceLlmUsd: 3.6,
            unattributedLlmUsd: 0.1,
            comparedDays: 1,
            uncomparedDays: 2,
            uncomparedLlmUsd: 12.25,
          },
        }),
      ),
    });
    const line = partly.find(".reconciliation").text().replace(/\s+/g, " ");
    expect(line).toContain("LLM attributed $3.50 of $3.60 on the workspace over 1 day");
    expect(line).toContain(
      "2 days with $12.25 of run tokens but no workspace figure (billed outside this workspace) not compared",
    );
    expect(line).not.toContain("-$");
    const none = mountApp(CostsPage, {
      seed: usersSeed(
        usersReport({
          reconciliation: {
            ...rec,
            attributedLlmUsd: 0,
            workspaceLlmUsd: 0,
            unattributedLlmUsd: 0,
            comparedDays: 0,
            uncomparedDays: 3,
            uncomparedLlmUsd: 15.75,
          },
        }),
      ),
    });
    const text = none.find(".reconciliation").text().replace(/\s+/g, " ");
    expect(text).toContain("no day in range has a workspace LLM figure to compare against");
    expect(text).not.toContain("LLM attributed");
    expect(text).toContain("3 days with $15.75 of run tokens");
  });

  it("keeps the tab on the range and group pills, names the by-user JSON twin, and says so when the by-user report did not come with the page", () => {
    const w = mountApp(CostsPage, { seed: usersSeed() });
    const hrefs = w.findAll("a").map((a) => a.attributes("href"));
    expect(hrefs).toContain("/costs/switchboard?days=7&view=users");
    expect(hrefs).toContain("/costs/other?days=3&view=users");
    expect(hrefs).toContain("/costs/switchboard?days=3"); // the Daily tab
    expect(w.text()).toContain("GET /costs/switchboard/users.json");
    const missing = mountApp(CostsPage, { seed: usersSeed(null) });
    expect(missing.text()).toContain("by-user report did not load");
    expect(missing.find("table.users").exists()).toBe(false);
  });
});
