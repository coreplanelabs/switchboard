// Feature: docs/reference/specs/browser-home.md — report completeness and canonical exports.
import { enableAutoUnmount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CostReport } from "@core/core/costs.js";
import { buildDeliveryReport } from "@core/core/delivery.js";
import type { ScheduledRow } from "@core/channels/scheduledPanel.js";
import { formatLocalIso } from "../../src/lib/format";
import type { HomeSeed } from "@core/channels/webSeed.js";
import { DAY_MS, MINUTE_MS } from "@core/core/budgets.js";
import { mountApp } from "../../src/testing/mount";
import { fakeEventSourceFactory } from "../../src/testing/fakeEventSource";
import CostsPage from "./Costs.vue";
import DeliveryPage from "./Delivery.vue";
import ScheduledPage from "./Scheduled.vue";
import RuntimePage from "./Runtime.vue";
import ThreadBrowserPage from "./ThreadBrowser.vue";

enableAutoUnmount(afterEach);
afterEach(() => vi.useRealTimers());
const day = (offset: number) => new Date(offset * DAY_MS).toISOString().slice(0, 10);
const snapshot = { snapshot: null, inFlight: null, everyHours: 24, nextAt: null, lastFailure: null };
const schedule: ScheduledRow = {
  name: "environment-check",
  worker: "resident",
  action: { type: "watchdog" },
  cron: "*/15 * * * *",
  description: "Check repository environments",
};
const report: CostReport = {
  group: "demo",
  label: "Demo",
  range: { from: day(0), to: day(0), days: 1, partialLastDay: true },
  llmAvailable: true,
  days: [
    {
      date: day(0),
      containers: {},
      durableObjects: {},
      doRequestsUsd: 0,
      doRowsUsd: 0,
      doStorageUsd: 0,
      workersUsd: 25,
      r2Usd: 0,
      workflowsUsd: 0,
      cloudUsd: 25,
      llmUsd: 0,
      llmEstimated: true,
      llmUnpricedTokens: 1200,
      total: 25,
    },
  ],
  totals: {
    cloudUsd: 25,
    llmUsd: 0,
    total: 25,
    byResource: {
      cpu: 0,
      memory: 0,
      disk: 0,
      durableObjects: 0,
      workers: 25,
      doRows: 0,
      doStorage: 0,
      r2: 0,
      workflows: 0,
    },
  },
  generatedAt: 0,
  account: { id: "demo", cloudUsd: 25 },
  attribution: { workers: [], containerApps: {}, durableObjectNamespaces: {}, r2Buckets: {}, workflows: {} },
};

describe("Green report states", () => {
  it("retains the recorded schedule run without a live link and exposes exact next and last times", () => {
    const next = 120_000,
      last = 30_000;
    const wrapper = mountApp(ScheduledPage, {
      seed: {
        page: "scheduled",
        now: 60_000,
        rows: [
          {
            ...schedule,
            nextFireAt: next,
            last: { firedAt: last, outcome: "completed", runId: "original-scheduled-run" },
          },
        ],
      },
    });
    expect(wrapper.text()).toContain("Run original-scheduled-run");
    expect(wrapper.text()).toContain("succeeded");
    expect(wrapper.find('a[href*="original-scheduled-run"]').exists()).toBe(false);
    expect(wrapper.findAll("time").map((time) => [time.attributes("datetime"), time.attributes("title")])).toEqual([
      ["1970-01-01T00:02:00.000Z", formatLocalIso(next)],
      ["1970-01-01T00:00:30.000Z", formatLocalIso(last)],
    ]);
  });
  it("keeps the global owner selection on a user cost breakdown without a second me filter", () => {
    const wrapper = mountApp(CostsPage, {
      seed: {
        page: "costs",
        group: "demo",
        groups: ["demo"],
        view: "users",
        report,
        snapshot,
        canSnapshot: false,
        dataView: { mode: "everyone", canViewEveryone: true },
        by: {
          group: "demo",
          dimension: "user",
          range: report.range,
          coverage: { from: day(0), retentionDays: 30, clamped: false, historyOn: true },
          rows: ["access:own", "access:peer"].map((key) => ({
            key,
            runs: 1,
            turns: 1,
            wallMs: 1,
            llmUsd: 2,
            cloudUsd: 0,
            totalUsd: 2,
            unpricedTokens: 0,
            byModel: {},
          })),
          days: [],
          pending: 0,
          cloudAllocated: false,
          reconciliation: {
            attributedLlmUsd: 4,
            workspaceLlmUsd: 4,
            unattributedLlmUsd: 0,
            comparedDays: 1,
            uncomparedDays: 0,
            uncomparedLlmUsd: 0,
            cloudAllocatedUsd: 0,
            cloudUnallocatedUsd: 0,
          },
          viewer: { userIds: ["access:own"], matchedByEmail: false },
          generatedAt: 0,
        },
      },
      eventSource: fakeEventSourceFactory().factory,
    });
    expect(wrapper.text()).toContain("own");
    expect(wrapper.text()).toContain("peer");
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
  });

  it("keeps the daily comparisons and group trend visible on every cost breakdown", () => {
    for (const view of ["daily", "users", "threads", "channels", "agents", "models"] as const) {
      const wrapper = mountApp(CostsPage, {
        seed: { page: "costs", group: "demo", groups: ["demo"], view, report, snapshot, canSnapshot: false },
        eventSource: fakeEventSourceFactory().factory,
      });
      expect(wrapper.text()).toContain("Today so far");
      expect(wrapper.text()).toContain("7-day average");
      expect(wrapper.text()).toContain("no full day yet in this range");
      expect(wrapper.find('[aria-label="Daily cost, stacked by component"]').exists()).toBe(true);
    }
    const fullDays = mountApp(CostsPage, {
      seed: {
        page: "costs",
        group: "demo",
        groups: ["demo"],
        view: "daily",
        snapshot,
        canSnapshot: false,
        report: {
          ...report,
          range: { from: day(0), to: day(2), days: 3, partialLastDay: true },
          days: [0, 1, 2].map((offset) => ({ ...report.days[0], date: day(offset) })),
        },
      },
      eventSource: fakeEventSourceFactory().factory,
    });
    const yesterday = fullDays.findAll(".green-stat").find((tile) => tile.find("dt").text() === "Yesterday")!;
    expect(yesterday.find("dd").text()).toBe("$25.00");
    expect(yesterday.find("p").text()).toBe("1970-01-02 · last full day, UTC");
    const average = fullDays.findAll(".green-stat").find((tile) => tile.find("dt").text() === "7-day average")!;
    expect(average.find("dd").text()).toBe("$25.00");
    expect(average.find("p").text()).toBe("per day, full days only");
  });
  it("keeps Delivery freshness visible and advancing while disclosing the counted identities", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2 * MINUTE_MS);
    const delivery = buildDeliveryReport({
      repo: "sample/api",
      range: { since: day(0), until: day(7), weeks: 1 },
      identities: { reviewers: ["review-helper"], agentLogins: ["build-helper"], agentCoauthors: ["Test Agent"] },
      prs: [],
      runs: [],
    });
    delivery.snapshotAt = "1970-01-01T00:00:00.000Z";
    const wrapper = mountApp(DeliveryPage, { seed: { page: "delivery", report: delivery, repos: ["sample/api"] } });
    expect(wrapper.find("[data-delivery-snapshot]").text()).toBe("As of Jan 1, 00:00 UTC, 2 minutes ago");
    expect(wrapper.find("[data-delivery-snapshot]").element.closest("details")).toBeNull();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(wrapper.find("[data-delivery-snapshot]").text()).toBe("As of Jan 1, 00:00 UTC, 3 minutes ago");
    expect(wrapper.find("details").text()).toContain("review-helper");
    expect(wrapper.find("details").text()).toContain("build-helper");
    expect(wrapper.find("details").text()).toContain("Test Agent");
  });
  it("distinguishes missing unit spend from an empty range and labels retained spending against the original cap", () => {
    const seed = {
      page: "costs" as const,
      group: "demo",
      groups: ["demo"],
      view: "daily" as const,
      canSnapshot: false,
      snapshot,
    };
    const unavailable = mountApp(CostsPage, {
      seed: { ...seed, report },
      eventSource: fakeEventSourceFactory().factory,
    });
    expect(unavailable.text()).toContain("Unit spend unavailable");
    expect(unavailable.text()).not.toContain("This range has no retained child runs");
    const empty = mountApp(CostsPage, {
      seed: { ...seed, report: { ...report, shipSpend: { range: report.range, units: [] } } },
      eventSource: fakeEventSourceFactory().factory,
    });
    expect(empty.text()).toContain("This range has no retained child runs with unit attribution.");
    const populated = mountApp(CostsPage, {
      eventSource: fakeEventSourceFactory().factory,
      seed: {
        ...seed,
        report: {
          ...report,
          shipSpend: {
            range: report.range,
            units: [
              {
                key: "plan:u1",
                capUsd: 75,
                totalUsd: 20,
                runs: [{ id: "child", finishedAt: 1, usd: 20, cumulativeUsd: 20 }],
              },
            ],
          },
        },
      },
    });
    expect(populated.find("[data-unit-spend-summary]").text()).toBe(
      "Retained-range total: $20.00 · Original cap $75.00",
    );
    expect(populated.find("[data-unit-spend-coverage]").text()).toContain(
      "Earlier runs and runs removed by retention are excluded.",
    );
    expect(populated.find("[data-unit-spend-coverage]").text()).toContain("Unit spend is shared across cost groups.");
  });
  it("keeps Delivery refresh ranges independent of URL fragments", async () => {
    const delivery = buildDeliveryReport({
      repo: "sample/api",
      range: { since: day(0), until: day(7), weeks: 8 },
      identities: { reviewers: [], agentCoauthors: [] },
      prs: [],
      runs: [],
    });
    const wrapper = mountApp(DeliveryPage, { seed: { page: "delivery", repos: ["sample/api"], report: delivery } });
    await wrapper.vm.$router.push("/delivery/sample/api?weeks=8#method");
    expect(
      wrapper
        .findAll("a")
        .find((link) => link.text() === "Refresh from GitHub")
        ?.attributes("href"),
    ).toBe("/delivery/sample/api?weeks=8&fresh=1");
    await wrapper.vm.$router.push("/delivery/sample/api?since=1970-01-01#method");
    expect(
      wrapper
        .findAll("a")
        .find((link) => link.text() === "Refresh from GitHub")
        ?.attributes("href"),
    ).toBe("/delivery/sample/api?since=1970-01-01&fresh=1");
  });
  it("keeps missing runtime data unavailable while a confirmed empty runtime shows zero counts", () => {
    for (const seed of [null, { page: "runNotFound", retentionDays: 30 } as const]) {
      const unavailable = mountApp(RuntimePage, { seed, eventSource: fakeEventSourceFactory().factory });
      expect(unavailable.find(".green-empty h3").text()).toBe("Runtime unavailable");
      expect(unavailable.findAll(".green-stat")).toHaveLength(0);
    }
    const empty = mountApp(RuntimePage, {
      seed: { page: "residents", cap: 4, count: 0, residents: [], repositories: [], runs: [], now: 0 },
      eventSource: fakeEventSourceFactory().factory,
    });
    expect(empty.find(".green-empty h3").text()).toBe("No repositories onboarded");
    expect(empty.findAll(".green-stat p").map((value) => value.text())).toEqual(["0 / 4", "0", "0"]);
  });
  it("distinguishes unavailable billing data from a confirmed absent first snapshot", () => {
    for (const seed of [null, { page: "runNotFound", retentionDays: 30 } as const]) {
      const unavailable = mountApp(CostsPage, { seed, eventSource: fakeEventSourceFactory().factory });
      expect(unavailable.find(".green-empty h3").text()).toBe("Costs unavailable");
      expect(unavailable.findAll(".green-stat")).toHaveLength(0);
    }
    const empty = mountApp(CostsPage, {
      seed: {
        page: "costs",
        group: "demo",
        groups: ["demo"],
        view: "daily",
        report: null,
        canSnapshot: false,
        snapshot,
      },
      eventSource: fakeEventSourceFactory().factory,
    });
    expect(empty.find(".green-empty h3").text()).toBe("No billing snapshot yet");
    expect(empty.text()).toContain("Totals appear when the first snapshot completes.");
  });
  it("limits thread discovery and filtering to the loaded browser list without implying full history coverage", async () => {
    for (const seed of [null, { page: "runNotFound", retentionDays: 30 } as const]) {
      const unavailable = mountApp(ThreadBrowserPage, { seed });
      expect(unavailable.find(".green-empty h3").text()).toBe("Threads unavailable");
      expect(unavailable.find("input").exists()).toBe(false);
    }
    const seed: HomeSeed = {
      page: "home",
      conversation: "broad",
      lane: "web:reader",
      sendUrl: "/threads/broad/send",
      turns: [],
      conversations: [],
      viewer: { name: "Reader" },
      now: 0,
      retentionDays: 30,
      suggestions: [],
      commands: [],
    };
    const empty = mountApp(ThreadBrowserPage, { seed });
    expect(empty.find(".green-empty h3").text()).toBe("No threads in the loaded browser list");
    expect(empty.find('[role="status"]').text()).toBe(
      "Coverage is unknown; the full retained history cannot be confirmed.",
    );
    const loaded = mountApp(ThreadBrowserPage, {
      seed: {
        ...seed,
        conversations: [
          { id: "visible", title: "Visible question", excerpt: "Visible question", lastAt: 0, runs: 1, live: false },
        ],
      },
    });
    expect(loaded.find(".green-section-heading h2").text()).toBe("Loaded browser conversations");
    expect(loaded.find('a[href="/threads/visible"]').text()).toContain("Visible question");
    await loaded.find("input").setValue("other question");
    expect(loaded.find(".green-empty h3").text()).toBe("No matches in the loaded browser list");
    expect(loaded.find(".green-empty p").text()).toBe(
      "This result covers only the loaded list. Full retained history cannot be confirmed.",
    );
  });
  it("warns that unpriced model usage is excluded from the shown estimate on every breakdown", () => {
    for (const view of ["daily", "users"] as const) {
      const wrapper = mountApp(CostsPage, {
        seed: { page: "costs", group: "demo", groups: ["demo"], view, report, canSnapshot: false, snapshot },
        eventSource: fakeEventSourceFactory().factory,
      });
      expect(wrapper.find('[role="status"][data-unpriced-model-usage]').text()).toBe(
        "1,200 tokens ran under models with no price and are excluded from the estimate. Shown totals do not include that usage.",
      );
      expect(
        wrapper
          .findAll(".green-stat")
          .find((tile) => tile.find("dt").text() === "Total in range")
          ?.find("dd")
          .text(),
      ).toBe("$25.00");
      const priced = mountApp(CostsPage, {
        seed: {
          page: "costs",
          group: "demo",
          groups: ["demo"],
          view,
          report: { ...report, days: [{ ...report.days[0], llmUnpricedTokens: 0 }] },
          canSnapshot: false,
          snapshot,
        },
        eventSource: fakeEventSourceFactory().factory,
      });
      expect(priced.find("h1").text()).toBe("Costs");
      expect(priced.find("[data-unpriced-model-usage]").exists()).toBe(false);
    }
  });
  it("exports trailing-slash delivery pages through the resolved repository and keeps the report filters", async () => {
    const delivery = buildDeliveryReport({
      repo: "sample/api",
      range: { since: day(0), until: day(7), weeks: 1 },
      identities: { reviewers: [], agentCoauthors: [] },
      prs: [],
      runs: [],
    });
    const wrapper = mountApp(DeliveryPage, { seed: { page: "delivery", report: delivery, repos: ["sample/api"] } });
    const router = wrapper.vm.$router;
    await router.push("/delivery/?weeks=4&fresh=1#method");
    const exportLink = () => wrapper.findAll("a").find((link) => link.text() === "Download this report as JSON")!;
    expect(exportLink().attributes("href")).toBe("/delivery/sample/api.json?weeks=4&fresh=1");
    await router.push(`/delivery/sample/api/?since=${day(0)}&fresh=1`);
    expect(exportLink().attributes("href")).toBe("/delivery/sample/api.json?since=1970-01-01&fresh=1");
    expect(wrapper.find('[aria-label="Delivery range"] a[href="/delivery/sample/api?weeks=8"]').text()).toBe("8w");
  });
  it("distinguishes unavailable schedule data from a successfully empty registry", () => {
    for (const seed of [
      null,
      { page: "runNotFound", retentionDays: 30 } as const,
      { page: "scheduled", now: 0, rows: null } as const,
    ]) {
      const wrapper = mountApp(ScheduledPage, { seed });
      expect(wrapper.find(".green-empty h3").text()).toBe("Schedule registry unavailable");
    }
    const empty = mountApp(ScheduledPage, { seed: { page: "scheduled", now: 0, rows: [] } });
    expect(empty.find(".green-empty h3").text()).toBe("No schedules");
  });
  it("keeps a missing last firing unknown when firing history is unavailable", () => {
    const unknown = mountApp(ScheduledPage, {
      seed: { page: "scheduled", now: 0, rows: [schedule], firingsUnavailable: "Firing history could not be read." },
    });
    expect(unknown.findAll("dd").at(-1)?.text()).toBe("Unknown: firing history is unavailable");
    const known = mountApp(ScheduledPage, { seed: { page: "scheduled", now: 0, rows: [schedule] } });
    expect(known.findAll("dd").at(-1)?.text()).toBe("No firing recorded");
  });
});
