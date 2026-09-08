import { describe, expect, it } from "vitest";
import type { Capabilities } from "@core/core/capabilities.js";
import type { WebSeed } from "@core/channels/webSeed.js";
import RunsTabs, { runsTabs } from "./RunsTabs.vue";
import { ALL_ON, mountApp } from "../../testing/mount";

// Feature: features/live-view.md — the runs page's tabs follow the
// installation's capabilities: Scheduled exists only with firing history
// configured (`schedules`) or when the viewer is on it; a lone tab draws no bar.

const island = (over: Partial<Capabilities> = {}): WebSeed => ({
  page: "runNotFound",
  retentionDays: null,
  capabilities: { ...ALL_ON, ...over },
});

describe("runsTabs — which tabs exist", () => {
  it("schedules on → Runs · Scheduled; off → Runs alone, unless the viewer is on Scheduled", () => {
    expect(runsTabs(ALL_ON, "runs").map((t) => t.id)).toEqual(["runs", "scheduled"]);
    expect(runsTabs({ ...ALL_ON, schedules: false }, "runs").map((t) => t.id)).toEqual(["runs"]);
    expect(runsTabs({ ...ALL_ON, schedules: false }, "scheduled").map((t) => t.id)).toEqual(["runs", "scheduled"]);
    expect(runsTabs(null, "runs").map((t) => t.id)).toEqual(["runs"]);
  });
});

describe("RunsTabs", () => {
  it("draws both tabs with the current one marked when schedules is on", () => {
    const w = mountApp(RunsTabs, { props: { current: "scheduled" }, seed: island() });
    expect(w.findAll("nav.tabs a").map((a) => a.attributes("href"))).toEqual(["/runs", "/runs/scheduled"]);
    expect(w.find('nav.tabs a[aria-current="page"]').attributes("href")).toBe("/runs/scheduled");
  });

  it("draws no tab bar at all on the Runs tab when schedules is off — one tab is no choice", () => {
    const w = mountApp(RunsTabs, { props: { current: "runs" }, seed: island({ schedules: false }) });
    expect(w.find("nav.tabs").exists()).toBe(false);
    expect(
      mountApp(RunsTabs, { props: { current: "runs" } })
        .find("nav.tabs")
        .exists(),
    ).toBe(false);
  });

  it("keeps the way back when the viewer is on Scheduled with schedules off", () => {
    const w = mountApp(RunsTabs, { props: { current: "scheduled" }, seed: island({ schedules: false }) });
    expect(w.findAll("nav.tabs a").map((a) => a.attributes("href"))).toEqual(["/runs", "/runs/scheduled"]);
  });
});
