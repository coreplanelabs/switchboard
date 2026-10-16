// Feature: docs/reference/specs/browser-home.md — attention, complete discovery, and workspace navigation.
import { enableAutoUnmount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import type { HomeSnapshot, HomeUnit } from "@core/core/home/service.js";
import HomePage from "./Home.vue";
import CostsPage from "./Costs.vue";
import PipelinePage from "./Pipeline.vue";
import MetricsPage from "./Metrics.vue";
import type { CostReport } from "@core/core/costs.js";
import { DAY_MS } from "@core/core/budgets.js";
import { fakeEventSourceFactory } from "../../src/testing/fakeEventSource";
import Shell from "../components/Shell.vue";
import UnitList from "../components/UnitList.vue";
import { mountApp } from "../../src/testing/mount";
enableAutoUnmount(afterEach);
function unit(id: string, title: string): HomeUnit {
  return {
    unit: {
      unit: `i:${id}`,
      instanceId: "i",
      id,
      title,
      branch: `codex/${id}`,
      threads: {},
      sourceUrls: {},
      rounds: [],
      idle: { why: "awaiting_review", at: 1, renewalsLeft: 1, wakes: 0 },
    },
    instance: { id: "i", repo: "sample/api", createdAt: 1 },
    conditions: [],
    nextAction: { kind: "unknown" },
  };
}
function snapshot(over: Partial<HomeSnapshot> = {}): HomeSnapshot {
  return {
    organizationId: "org",
    status: "complete",
    access: "authorized",
    needsYou: [],
    moving: [],
    waiting: [],
    pipelines: [],
    ...over,
  };
}
describe("Green browser frontend", () => {
  it("distinguishes partial and unknown pipeline coverage from a complete unit read", () => {
    const pipeline = {
      instance: { id: "i", repo: "sample/api", createdAt: 1 },
      unresolved: 1,
      needsYou: 0,
      moving: 0,
      waiting: 1,
      units: [unit("known", "Known unit")],
    };
    const partial = mountApp(PipelinePage, { seed: { page: "fleetPipeline", pipeline, status: "partial" } });
    expect(partial.text()).toContain("Some work details could not be loaded. This view is incomplete.");
    const unknown = mountApp(PipelinePage, { seed: { page: "fleetPipeline", pipeline } });
    expect(unknown.text()).toContain("Unit coverage is unknown. The list cannot confirm all work.");
    const complete = mountApp(PipelinePage, { seed: { page: "fleetPipeline", pipeline, status: "complete" } });
    expect(complete.text()).toContain("Known unit");
    expect(complete.text()).not.toContain("coverage is unknown");
    expect(complete.text()).not.toContain("This view is incomplete.");
  });
  it("keeps missing model billing unknown while showing the known cloud total", () => {
    const date = new Date(0).toISOString().slice(0, 10);
    const report: CostReport = {
      group: "demo",
      label: "Demo",
      range: { from: date, to: new Date(29 * DAY_MS).toISOString().slice(0, 10), days: 30, partialLastDay: false },
      llmAvailable: false,
      days: [
        {
          date,
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
          llmEstimated: false,
          llmUnpricedTokens: 0,
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
    const wrapper = mountApp(CostsPage, {
      seed: {
        page: "costs",
        group: "demo",
        groups: ["demo", "other"],
        view: "users",
        report,
        canSnapshot: false,
        snapshot: { snapshot: null, inFlight: null, everyHours: 24, nextAt: null, lastFailure: null },
      },
      eventSource: fakeEventSourceFactory().factory,
    });
    const tiles = wrapper.findAll(".green-stat");
    const model = tiles.find((tile) => tile.find("dt").text() === "Model usage")!;
    expect(model.find("dd").text()).toBe("—");
    expect(model.text()).toContain("not configured");
    expect(
      tiles
        .find((tile) => tile.find("dt").text() === "Total in range")!
        .find("dd")
        .text(),
    ).toBe("$25.00");
    expect(wrapper.find('[aria-label="Cost groups"] a[href="/costs/other?days=30&view=users"]').exists()).toBe(true);
    expect(
      wrapper
        .findAll("a")
        .find((link) => link.text() === "Download report as JSON")
        ?.attributes("href"),
    ).toBe("/costs/demo/users.json?days=30");
  });
  it("opens durable pipeline context without fabricating a live run capability", () => {
    const pipeline = {
      instance: { id: "i", runId: "live-private-capability", repo: "sample/api", createdAt: 1 },
      unresolved: 1,
      needsYou: 0,
      moving: 0,
      waiting: 1,
    };
    const home = mountApp(HomePage, {
      seed: {
        page: "fleetHome",
        snapshot: snapshot({ waiting: [unit("question", "Question")], pipelines: [pipeline] }),
      },
    });
    expect(home.find('a[href="/pipelines/i"]').exists()).toBe(true);
    expect(home.find('a[href="/runs/live-private-capability"]').exists()).toBe(false);
    const page = mountApp(PipelinePage, { seed: { page: "fleetPipeline", pipeline: { ...pipeline, units: [] } } });
    expect(page.find('a[href="/runs/live-private-capability"]').exists()).toBe(false);
  });
  it("keeps unavailable metrics distinct from a zero-usage report", () => {
    const wrapper = mountApp(MetricsPage, { seed: null });
    expect(wrapper.text()).toContain("The review report is unavailable. No usage totals are shown.");
    expect(wrapper.findAll(".green-stat")).toHaveLength(0);
    expect(wrapper.find('[aria-label="Metrics sections"] a[href="/metrics/health"]').text()).toBe("System health");
  });
  it("presents personal attention before moving work and other waits", () => {
    const need = unit("question", "Review the validation receipt");
    need.conditions = [
      {
        id: "q",
        unitKey: "i:question",
        revision: 1,
        state: "open",
        owner: { kind: "person", id: "access:alice" },
        summary: "Confirm the deployment target",
        nextAction: "Choose the staging target",
      },
    ];
    need.nextAction = { kind: "recorded", text: "Choose the staging target" };
    const wrapper = mountApp(HomePage, {
      seed: {
        page: "fleetHome",
        attentionRecipient: "access:alice",
        snapshot: snapshot({
          needsYou: [need],
          moving: [unit("moving", "Build the route")],
          waiting: [unit("waiting", "Wait for checks")],
        }),
      },
    });
    expect(wrapper.findAll(".green-section-heading h2").map((heading) => heading.text())).toEqual([
      "Needs you 1",
      "Moving 1",
      "Other waits 1",
    ]);
    expect(wrapper.text()).toContain("Confirm the deployment target");
    expect(wrapper.text()).toContain("Choose the staging target");
    expect(wrapper.text()).toContain("Next action not recorded");
    expect(wrapper.findAll(".green-unit-row .green-badge").map((badge) => badge.text())).toEqual([
      "Waiting",
      "Working",
      "Waiting",
    ]);
    expect(wrapper.text()).not.toContain("In progress");
    expect(wrapper.text()).toContain("You");
    expect(wrapper.text()).not.toContain("Requester: access:alice");
  });
  it("labels only the exact attention recipient as You on a unit with mixed person conditions", () => {
    const need = unit("question", "Review two decisions");
    need.conditions = ["access:alice", "access:bob"].map((person, index) => ({
      id: `q${index}`,
      unitKey: "i:question",
      revision: 1,
      state: "open",
      owner: { kind: "person", id: person },
      summary: `Decision ${index}`,
      nextAction: `Answer decision ${index}`,
    }));
    const wrapper = mountApp(HomePage, {
      seed: { page: "fleetHome", attentionRecipient: "access:alice", snapshot: snapshot({ needsYou: [need] }) },
    });
    expect(wrapper.find(".green-unit-owner").text()).toBe("You · Assigned to: access:bob");
    const unknown = mountApp(HomePage, { seed: { page: "fleetHome", snapshot: snapshot({ needsYou: [need] }) } });
    expect(unknown.find(".green-unit-owner").text()).toBe("Assigned to: access:alice · Assigned to: access:bob");
  });
  it("distinguishes incomplete, filtered, and fully caught-up fleet states", () => {
    const partial = mountApp(HomePage, { seed: { page: "fleetHome", snapshot: snapshot({ status: "partial" }) } });
    expect(partial.text()).toContain("Some work could not be loaded.");
    expect(partial.text()).not.toContain("All caught up");
    const filtered = mountApp(HomePage, { seed: { page: "fleetHome", snapshot: snapshot({ access: "filtered" }) } });
    expect(filtered.text()).toContain("No unresolved work in your view");
    const complete = mountApp(HomePage, { seed: { page: "fleetHome", snapshot: snapshot() } });
    expect(complete.text()).toContain("All caught up");
  });
  it("finds the last unresolved unit in a thousand-row list and shows its complete next action", async () => {
    const rows = Array.from({ length: 1001 }, (_, index) =>
      unit(String(index), index === 1000 ? "Last retained question" : `Work ${index}`),
    );
    rows[1000].nextAction = { kind: "recorded", text: "Confirm the full staging receipt before continuing" };
    const wrapper = mountApp(UnitList, { props: { rows, label: "Other waits" } });
    expect(wrapper.text()).toContain("1001 matching units.");
    expect(wrapper.findAll("[role=listitem]").length).toBeLessThan(30);
    const viewport = wrapper.find('[tabindex="0"]');
    await viewport.trigger("keydown", { key: "End" });
    expect(wrapper.findAll("[role=listitem]").at(-1)?.attributes("aria-posinset")).toBe("1001");
    expect(wrapper.text()).toContain("Last retained question");
    await wrapper.find("input").setValue("Last retained question");
    expect(wrapper.find("[role=listitem]").attributes("aria-setsize")).toBe("1");
    expect(wrapper.text()).toContain("Last retained question");
    expect(wrapper.text()).toContain("Confirm the full staging receipt before continuing");
  });
  it("keeps exactly the four primary destinations and a separate advanced run link", () => {
    const wrapper = mountApp(Shell, { seed: { page: "fleetHome", snapshot: snapshot() } });
    expect(
      wrapper
        .findAll(".green-nav")
        .at(0)
        ?.findAll("a")
        .map((link) => link.text()),
    ).toEqual(["Home", "Delivery", "Costs", "Metrics"]);
    expect(wrapper.findAll(".green-sidebar-bottom a").map((link) => link.text())).toContain("Run details");
  });
});
