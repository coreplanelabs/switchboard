// Feature: docs/reference/specs/costs.md, delivery.md and resident-repos.md — selected work never invents shared totals.
import { enableAutoUnmount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import type { CostWorkReport } from "@core/core/costsService.js";
import { buildDeliveryReport } from "@core/core/delivery.js";
import { mountApp } from "../../src/testing/mount";
import { fakeEventSourceFactory } from "../../src/testing/fakeEventSource";
import CostsPage from "./Costs.vue";
import DeliveryPage from "./Delivery.vue";
import RuntimePage from "./Runtime.vue";

enableAutoUnmount(afterEach);
const work: CostWorkReport = {
  scope: "personal",
  group: "sample",
  dimension: "model",
  range: { from: "1970-01-01", to: "1970-01-30", days: 30, partialLastDay: true },
  coverage: { from: "1970-01-01", retentionDays: 30, clamped: false, historyOn: true },
  rows: [
    {
      key: "sample/model",
      runs: 2,
      turns: 4,
      wallMs: 10,
      llmUsd: 2.5,
      totalUsd: 2.5,
      unpricedTokens: 120,
      byModel: {},
    },
  ],
  days: [{ day: "1970-01-01", key: "sample/model", runs: 2, turns: 4, wallMs: 10, llmUsd: 2.5, unpricedTokens: 120 }],
  generatedAt: 0,
  infrastructure: "unattributed",
  completeness: "complete",
  unitSpendStatus: "complete",
  shipSpend: {
    range: { from: "1970-01-01", to: "1970-01-30", days: 30, partialLastDay: true },
    units: [
      {
        key: "sample:U10",
        capUsd: 20,
        totalUsd: 4.5,
        runs: [{ id: "owned-run", finishedAt: 1, usd: 4.5, cumulativeUsd: 4.5 }],
      },
    ],
  },
};
const costsSeed = (data: CostWorkReport) => ({
  page: "costs" as const,
  group: "sample",
  groups: ["sample", "other"],
  view: "daily" as const,
  report: null,
  work: data,
  snapshot: { snapshot: null, inFlight: null, everyHours: 24, nextAt: null, lastFailure: null },
  canSnapshot: true,
});

describe("Green personal reports", () => {
  it("renders personal model and unit spending independently of shared billing and keeps selected ranges", () => {
    const events = fakeEventSourceFactory();
    const wrapper = mountApp(CostsPage, { seed: costsSeed(work), eventSource: events.factory });
    expect(wrapper.text()).toContain("Known model spend");
    expect(wrapper.text()).toContain("$2.50");
    expect(wrapper.text()).toContain("sample/model");
    expect(wrapper.text()).toContain("120 unpriced tokens");
    expect(wrapper.find("[data-unit-spend-summary]").text()).toBe("Retained-range total: $4.50 · Original cap $20.00");
    expect(wrapper.find('a[href="/runs/owned-run"]').exists()).toBe(true);
    expect(wrapper.find('a[href="/costs/other?days=30"]').text()).toBe("other");
    expect(wrapper.find('a[href="/costs/sample?days=30&view=users"]').text()).toBe("By user");
    expect(wrapper.find('a[href="/costs/sample.json?days=30"]').text()).toBe("Download report as JSON");
    for (const text of [
      "No billing snapshot yet",
      "Cloud components",
      "Cloud account share",
      "Invoice comparison",
      "Monthly projection",
      "Snapshot now",
    ])
      expect(wrapper.text()).not.toContain(text);
    expect(events.created).toEqual([]);
  });

  it("keeps unavailable and partial personal costs separate from confirmed empty work", () => {
    for (const completeness of ["unavailable", "partial"] as const) {
      const wrapper = mountApp(CostsPage, {
        seed: costsSeed({
          ...work,
          rows: [],
          days: [],
          completeness,
          unitSpendStatus: completeness,
          shipSpend: { range: work.range, units: [] },
        }),
        eventSource: fakeEventSourceFactory().factory,
      });
      expect(wrapper.text()).toContain(
        completeness === "unavailable" ? "Personal usage unavailable" : "Personal usage is incomplete",
      );
      expect(wrapper.text()).toContain(
        completeness === "unavailable" ? "Unit spend unavailable" : "Unit spend is incomplete",
      );
      expect(wrapper.text()).not.toContain("$0.00");
      expect(wrapper.text()).not.toContain("No recorded model usage");
      expect(wrapper.text()).not.toContain("No retained unit spend");
    }
    const empty = mountApp(CostsPage, {
      seed: costsSeed({ ...work, rows: [], days: [], shipSpend: { range: work.range, units: [] } }),
      eventSource: fakeEventSourceFactory().factory,
    });
    expect(empty.text()).toContain("No recorded model usage");
    expect(empty.text()).toContain("No retained unit spend");
    expect(empty.text()).toContain("$0.00");
  });

  it("renders shared-runtime unavailability without a shared stream or invented zero statistics", () => {
    const events = fakeEventSourceFactory();
    const wrapper = mountApp(RuntimePage, {
      seed: {
        page: "residents",
        residents: [],
        runs: [],
        now: 0,
        scopeUnavailable: "Select All people to see the shared runtime.",
      },
      eventSource: events.factory,
    });
    expect(wrapper.find(".green-empty h3").text()).toBe("Shared runtime");
    expect(wrapper.find(".green-empty p").text()).toBe("Select All people to see the shared runtime.");
    expect(wrapper.findAll(".green-stat")).toEqual([]);
    expect(wrapper.text()).not.toContain("connecting");
    expect(events.created).toEqual([]);
  });

  it("labels partial unit spend as a known subtotal and keeps a missing total unknown", () => {
    const known = mountApp(CostsPage, {
      seed: costsSeed({ ...work, unitSpendStatus: "partial" }),
      eventSource: fakeEventSourceFactory().factory,
    });
    expect(known.find("[data-unit-spend-summary]").text()).toBe(
      "Known retained-range subtotal: $4.50 · Original cap $20.00",
    );
    const unknown = mountApp(CostsPage, {
      seed: costsSeed({
        ...work,
        unitSpendStatus: "partial",
        shipSpend: { range: work.range, units: [{ ...work.shipSpend!.units[0], totalUsd: 0, runs: [] }] },
      }),
      eventSource: fakeEventSourceFactory().factory,
    });
    expect(unknown.find("[data-unit-spend-summary]").text()).toBe("Retained-range total unknown · Original cap $20.00");
  });

  it("keeps incomplete delivery distinct from no merges while retaining freshness and counted identities", () => {
    const report = buildDeliveryReport({
      repo: "sample/api",
      range: { since: "1970-01-01", until: "1970-01-08", weeks: 1 },
      identities: { reviewers: ["review-helper"], agentLogins: ["build-helper"], agentCoauthors: ["Test Agent"] },
      prs: [],
      runs: [],
    });
    report.snapshotAt = "1970-01-01T00:00:00.000Z";
    for (const workCoverage of ["partial", "unavailable"] as const) {
      const wrapper = mountApp(DeliveryPage, {
        seed: { page: "delivery", report: { ...report, workCoverage }, repos: ["sample/api"] },
      });
      expect(wrapper.text()).toContain(
        workCoverage === "partial" ? "Selected work coverage is incomplete" : "Selected work coverage is unavailable",
      );
      expect(wrapper.text()).not.toContain("No merges in this range");
      expect(wrapper.findAll(".green-stat")).toEqual([]);
      expect(wrapper.find("[data-delivery-snapshot]").text()).toContain("As of Jan 1, 00:00 UTC");
      expect(wrapper.find("details").text()).toContain("review-helper");
      expect(wrapper.find("details").text()).toContain("build-helper");
    }
    const complete = mountApp(DeliveryPage, {
      seed: { page: "delivery", report: { ...report, workCoverage: "complete" }, repos: ["sample/api"] },
    });
    expect(complete.text()).toContain("No merges in this range");
    expect(complete.findAll(".green-stat").length).toBe(6);
  });
});
