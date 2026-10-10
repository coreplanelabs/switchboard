// Feature: docs/reference/specs/browser-home.md — missing run data is not a confirmed empty registry.
import { enableAutoUnmount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { mountApp } from "../../src/testing/mount";
import Runs from "./Runs.vue";
import RuntimeDetail from "./RuntimeDetail.vue";
import { fakeEventSourceFactory } from "../../src/testing/fakeEventSource";
import type { RunIndexRowSeed } from "@core/channels/webSeed.js";
import { DAY_MS } from "@core/core/budgets.js";
enableAutoUnmount(afterEach);
describe("Run discovery availability", () => {
  it("keeps children associated with their selected group head across both retention branches", () => {
    const now = 100 * DAY_MS;
    const row = (id: string, daysAgo: number, facts: Partial<RunIndexRowSeed> = {}): RunIndexRowSeed => ({
      id,
      label: id,
      finished: true,
      startedAt: now - daysAgo * DAY_MS - 1000,
      finishedAt: now - daysAgo * DAY_MS,
      eventCount: 0,
      status: "completed",
      ...facts,
    });
    const rows = [
      row("fresh", 2, { instanceId: "fresh-instance" }),
      row("fresh-unit", 2, { parentInstanceId: "fresh-instance" }),
      row("fresh-child", 2, { parentRunId: "fresh" }),
      row("fresh-grandchild", 2, { parentRunId: "fresh-child" }),
      row("soon", 29.5, { instanceId: "soon-instance" }),
      row("soon-unit", 29.5, { parentInstanceId: "soon-instance" }),
      row("soon-child", 29.5, { parentRunId: "soon" }),
      row("soon-grandchild", 29.5, { parentRunId: "soon-child" }),
      row("orphan", 1, { parentRunId: "absent" }),
      row("independent", 1),
      row("cycle-a", 1, { parentRunId: "cycle-b" }),
      row("cycle-b", 1, { parentRunId: "cycle-a" }),
    ];
    for (const retentionDays of [30, null]) {
      const page = mountApp(Runs, {
        seed: { page: "runs", all: true, mine: false, retentionDays, now, rows },
        eventSource: fakeEventSourceFactory().factory,
      });
      expect(
        Object.fromEntries(
          page
            .findAll("#runs > [data-run-id]")
            .map((run) => [
              run.attributes("data-run-id"),
              { parent: run.attributes("data-parent-id") ?? null, nested: run.classes().includes("nested") },
            ]),
        ),
      ).toEqual({
        fresh: { parent: null, nested: false },
        "fresh-unit": { parent: "fresh", nested: true },
        "fresh-child": { parent: "fresh", nested: true },
        "fresh-grandchild": { parent: "fresh", nested: true },
        soon: { parent: null, nested: false },
        "soon-unit": { parent: "soon", nested: true },
        "soon-child": { parent: "soon", nested: true },
        "soon-grandchild": { parent: "soon", nested: true },
        orphan: { parent: null, nested: false },
        independent: { parent: null, nested: false },
        "cycle-a": { parent: null, nested: false },
        "cycle-b": { parent: null, nested: false },
      });
      expect(page.find("#runs").text().includes("The following retained runs expire within one day.")).toBe(
        retentionDays === 30,
      );
    }
  });
  it("keeps a missing repository environment unavailable instead of inventing empty runtime facts", () => {
    for (const seed of [null, { page: "runNotFound", retentionDays: 30 } as const]) {
      const page = mountApp(RuntimeDetail, { seed });
      expect(page.find(".green-empty h3").text()).toBe("Runtime unavailable");
      expect(page.findAll(".green-facts")).toHaveLength(0);
      expect(page.text()).not.toContain("No worktrees recorded");
      expect(page.text()).not.toContain("No command table recorded");
    }
    const known = mountApp(RuntimeDetail, {
      seed: { page: "resident", slug: "sample/api", record: { live: { state: "warm" } } },
    });
    expect(known.find("h1").text()).toBe("sample/api");
    expect(known.find(".green-section-heading .green-badge").text()).toBe("warm");
    expect(known.text()).toContain("No worktrees recorded.");
    expect(known.text()).toContain("No command table recorded.");
  });
  it("shows unavailable data instead of claiming that no runs are live", () => {
    const stream = fakeEventSourceFactory();
    const page = mountApp(Runs, { seed: null, eventSource: stream.factory });
    expect(page.text()).toContain("Run data is unavailable");
    expect(page.text()).not.toContain("No runs are live");
    expect(stream.created).toHaveLength(0);
  });
});
