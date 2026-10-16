// Feature: docs/reference/specs/browser-home.md — recorded pipeline attention, completion and plan context.
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import type { HomePipelineSeed } from "@core/channels/homeSeed.js";
import type { HomeUnit } from "@core/core/home/service.js";
import Pipeline from "./Pipeline.vue";
import { mountApp } from "../../src/testing/mount";
enableAutoUnmount(afterEach);
const instance = {
  id: "pipeline",
  repo: "sample/api",
  base: "release/next",
  createdAt: 1,
  plan: { id: "recorded-plan", path: "docs/My plan.md" },
  sourceUrl: "https://example.com/original-thread",
};
function row(id: string, completion: "complete" | "active" | "unknown"): HomeUnit {
  return {
    unit: {
      unit: `pipeline:${id}`,
      instanceId: "pipeline",
      id,
      title: `Work ${id}`,
      branch: `work/${id}`,
      threads: { coding: `slack:C1:${id}` },
      sourceUrls: {},
      rounds: [],
      pr: { number: 42, url: "https://github.com/sample/api/pull/42" },
    },
    instance,
    completion,
    conditions: [],
    nextAction: { kind: "unknown" },
  };
}
function seed(): HomePipelineSeed {
  const mine = row("asked", "active");
  mine.conditions = [
    {
      id: "question",
      unitKey: "pipeline:asked",
      revision: 1,
      state: "open",
      owner: { kind: "person", id: "access:alice" },
      summary: "Choose staging",
      nextAction: "Approve the saved target",
    },
  ];
  mine.nextAction = { kind: "recorded", text: "Approve the saved target" };
  return {
    page: "fleetPipeline",
    status: "partial",
    attentionRecipient: "access:alice",
    pipeline: {
      instance,
      unresolved: 2,
      needsYou: 1,
      waiting: 2,
      moving: 0,
      units: [mine, row("done", "complete"), row("unknown", "unknown")],
    },
  };
}
describe("Pipeline work navigation", () => {
  it("summarizes recorded attention and separates completed work with keyboard tabs while retaining original links", async () => {
    const page = mountApp(Pipeline, { seed: seed() });
    const summary = page.get('[aria-label="Pipeline attention"]');
    expect(summary.text()).toContain("Needs you 1");
    expect(summary.text()).toContain("Approve the saved target");
    expect(page.findAll("[data-unit]").map((unit) => unit.attributes("data-unit"))).toEqual([
      "pipeline:asked",
      "pipeline:unknown",
    ]);
    expect(page.text()).toContain("Completion is unknown for 1 unit");
    const asked = page.get('[data-unit="pipeline:asked"]');
    expect(asked.get('a[aria-label="Original unit thread"]').attributes("href")).toBe("/threads/slack%3AC1%3Aasked");
    expect(asked.get('a[aria-label="Changes"]').attributes("href")).toBe("/runs/unit/pipeline%3Aasked#changes");
    expect(asked.findAll("a").some((a) => a.attributes("href") === "https://github.com/sample/api/pull/42")).toBe(true);
    expect(page.get('a[aria-label="Asking thread"]').attributes("href")).toBe("https://example.com/original-thread");
    const tabs = page.findAll('[role="tab"]');
    expect(tabs.map((tab) => tab.text())).toEqual(["Active 2", "Completed 1"]);
    for (const tab of tabs) expect(page.find(`#${tab.attributes("aria-controls")}`).exists()).toBe(true);
    (tabs[0].element as HTMLElement).focus();
    await tabs[0].trigger("keydown", { key: "ArrowRight" });
    await flushPromises();
    expect(document.activeElement).toBe(tabs[1].element);
    expect(tabs[1].attributes("aria-selected")).toBe("true");
    expect(page.get('[role="tabpanel"]:not([hidden])').attributes("aria-labelledby")).toBe(tabs[1].attributes("id"));
    expect(page.findAll("[data-unit]").map((unit) => unit.attributes("data-unit"))).toEqual(["pipeline:done"]);
    await tabs[1].trigger("keydown", { key: "Home" });
    await flushPromises();
    expect(document.activeElement).toBe(tabs[0].element);
    expect(page.findAll("[data-unit]").map((unit) => unit.attributes("data-unit"))).toEqual([
      "pipeline:asked",
      "pipeline:unknown",
    ]);
  });
  it("bounds the next-action summary while keeping every active unit reachable by keyboard", async () => {
    const value = seed();
    const units = Array.from({ length: 50 }, (_, index) => ({
      ...row(`job${index}`, "active"),
      nextAction: { kind: "recorded" as const, text: `Recorded action ${index}` },
    }));
    const page = mountApp(Pipeline, { seed: { ...value, pipeline: { ...value.pipeline!, units } } });
    const summary = page.get('[aria-label="Pipeline attention"]');
    expect(summary.findAll("li").map((item) => item.text())).toEqual([
      "Work job0 · Recorded action 0",
      "Work job1 · Recorded action 1",
      "Work job2 · Recorded action 2",
    ]);
    expect(summary.text()).toContain("47 more recorded actions in Active.");
    const list = page.get('[aria-label="Active units: 50 units"]');
    await list.trigger("keydown", { key: "End" });
    await flushPromises();
    expect(page.get('[data-unit="pipeline:job49"]').text()).toContain("Recorded action 49");
  });
  it("links a recorded plan only from its repository, base and safe path and keeps other address data plain", () => {
    const page = mountApp(Pipeline, { seed: seed() });
    expect(page.get('a[aria-label="Open recorded plan"]').attributes("href")).toBe(
      "https://github.com/sample/api/blob/release/next/docs/My%20plan.md",
    );
    for (const changed of [
      { base: undefined },
      { repo: "javascript:invalid" },
      { plan: { id: "recorded-plan", path: "../private.md" } },
      { plan: undefined },
    ]) {
      const value = seed();
      const unknown = mountApp(Pipeline, {
        seed: { ...value, pipeline: { ...value.pipeline!, instance: { ...instance, ...changed } } },
      });
      expect(unknown.find('a[aria-label="Open recorded plan"]').exists()).toBe(false);
      expect(unknown.text()).toContain(
        changed.plan === undefined && "plan" in changed ? "No plan address was recorded" : "Plan link unavailable",
      );
    }
  });
  it("uses only proved recipients for attention and keeps unclassified work visible without inferring completion from its ending", () => {
    const value = seed();
    const unknown = row("old", "unknown");
    delete unknown.completion;
    unknown.unit.ending = { kind: "merged", at: 1 };
    const page = mountApp(Pipeline, {
      seed: {
        ...value,
        attentionRecipient: "access:bob",
        pipeline: { ...value.pipeline!, units: [value.pipeline!.units[0], unknown] },
      },
    });
    expect(page.get('[aria-label="Pipeline attention"]').text()).toContain("Needs you 0");
    expect(page.findAll("[data-unit]").map((unit) => unit.attributes("data-unit"))).toEqual([
      "pipeline:asked",
      "pipeline:old",
    ]);
    expect(page.findAll('[role="tab"]').map((tab) => tab.text())).toEqual(["Active 2", "Completed 0"]);
    expect(page.get('[data-unit="pipeline:asked"]').text()).toContain("Assigned to: access:alice");
  });
});
