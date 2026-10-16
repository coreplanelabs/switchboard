import { describe, expect, it } from "vitest";
import { h } from "vue";
import Shell from "../../green/components/Shell.vue";
import ScheduledPage from "../../green/pages/Scheduled.vue";
import { mountApp } from "../testing/mount";
import { formatLocalIso } from "../lib/format";
import type { ScheduledSeed } from "@core/channels/webSeed.js";
import type { ScheduledRow } from "@core/channels/scheduledPanel.js";

const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);

const RUN_ROW: ScheduledRow = {
  name: "self-improvement",
  worker: "bot",
  action: {
    type: "run",
    command: "friction propose",
    identity: "cron",
    actor: {
      kind: "schedule",
      id: "schedule:self-improvement",
      grants: { actions: new Set<string>(), channels: "all", repos: new Set<string>() },
    },
  },
  cron: "0 14 * * 1",
  description: "Weekly friction proposals",
  nextFireAt: Date.UTC(2026, 7, 31, 14, 0, 0),
  last: {
    firedAt: Date.UTC(2026, 7, 24, 14, 0, 0),
    outcome: "completed",
    runId: "0a1b2c3d4e5f6789",
    runHref: "/runs/0a1b2c3d4e5f6789?t=tok-live",
    detail: "*Friction proposals* — 2 filed  1. `long_run` …",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  },
};

const WATCHDOG_ROW: ScheduledRow = {
  name: "resident-watchdog",
  worker: "resident",
  action: { type: "watchdog" },
  cron: "*/15 * * * *",
  description: "Sweep resident refresh stalls",
};

const seed = (rows: ScheduledRow[] | null, firingsUnavailable?: string): ScheduledSeed => ({
  page: "scheduled",
  now: NOW,
  rows,
  ...(firingsUnavailable ? { firingsUnavailable } : {}),
});

describe("ScheduledPage", () => {
  it("marks Scheduled work in the global navigation with Run details one click away", async () => {
    const wrapper = mountApp(Shell, {
      seed: { page: "scheduled", now: NOW, rows: [] },
      slots: { default: () => h(ScheduledPage) },
    });
    await wrapper.findComponent(Shell).vm.$router.push("/runs/scheduled");
    expect(wrapper.find('a[href="/runs/scheduled"][aria-current="page"]').text()).toBe("Scheduled work");
    expect(wrapper.find('a[href="/runs"]').text()).toBe("Run details");
    expect(wrapper.find("h1").text()).toBe("Scheduled work");
  });

  it("renders one block per schedule: name · cron UTC · worker · command as identity · next fire in the viewer's clock", () => {
    const w = mountApp(ScheduledPage, { seed: seed([RUN_ROW]) });
    const t = w.text();
    expect(t).toContain("self-improvement");
    expect(t).toContain("0 14 * * 1");
    expect(t).toContain("UTC"); // the cron expression is defined in UTC — that label stays on the chip
    expect(t).toContain("bot");
    expect(t).toContain("friction propose");
    expect(t).toContain("cron");
    // The next-fire stamp reads in the viewer's timezone, exact local ISO on hover — never UTC.
    const next = w.findAll("time")[0];
    expect(next.text()).toBe("in 1d 2h");
    expect(next.text()).not.toContain("UTC");
    expect(next.attributes("title")).toBe(formatLocalIso(RUN_ROW.nextFireAt!));
    expect(t).toContain("in 1d 2h");
  });

  it("labels non-run actions and preserves a missing next firing", () => {
    const w = mountApp(ScheduledPage, { seed: seed([WATCHDOG_ROW]) });
    expect(w.text()).toContain("resident watchdog");
    expect(w.text()).toContain("No next firing");
  });

  it("shows the last firing: outcome word ('succeeded'), relative time with the exact local time on hover, a token'd run link, the detail's facts", () => {
    const w = mountApp(ScheduledPage, { seed: seed([RUN_ROW]) });
    expect(w.text()).toContain("succeeded");
    expect(w.text()).toContain("ago");
    expect(w.findAll("time")[1].attributes("title")).toBe(formatLocalIso(RUN_ROW.last!.firedAt));
    const run = w.get('a[href="/runs/0a1b2c3d4e5f6789?t=tok-live"]');
    expect(run?.attributes("href")).toBe("/runs/0a1b2c3d4e5f6789?t=tok-live");
    expect(run?.text()).toContain("Run details");
    expect(w.text()).toContain("Trace 4bf92f3577b34da6a3ce929d0e0e4736");
    expect(w.text()).toContain("*Friction proposals* — 2 filed");
  });

  it("shows a bare run id (no link) when the firing's run is not live, and no trace cell for a firing recorded without one", () => {
    const row: ScheduledRow = { ...RUN_ROW, last: { ...RUN_ROW.last!, runHref: undefined, traceId: undefined } };
    const w = mountApp(ScheduledPage, { seed: seed([row]) });
    expect(w.text()).toContain("Run 0a1b2c3d4e5f6789");
    expect(w.text()).not.toContain("Trace ");
    expect(w.findAll("a").some((a) => a.text().startsWith("Run details"))).toBe(false);
  });

  it("keeps no recorded firing distinct from unavailable firing history", () => {
    const noFiring: ScheduledRow = { ...RUN_ROW, last: undefined };
    expect(mountApp(ScheduledPage, { seed: seed([noFiring]) }).text()).toContain("No firing recorded");
    const w = mountApp(ScheduledPage, { seed: seed([noFiring], "schedules.worker is not configured") });
    expect(w.text()).toContain("Unknown: firing history is unavailable");
    expect(w.text()).toContain("schedules.worker is not configured");
  });

  it("says so when no schedule registry is configured (rows null)", () => {
    const w = mountApp(ScheduledPage, { seed: seed(null) });
    expect(w.text()).toContain("Schedule registry unavailable");
  });

  it("renders hostile names/details as text, never elements", () => {
    const hostile: ScheduledRow = {
      ...RUN_ROW,
      name: "<img src=x>",
      last: { ...RUN_ROW.last!, detail: "<script>alert(1)</script> broke" },
    };
    const w = mountApp(ScheduledPage, { seed: seed([hostile]) });
    expect(w.find("#scheduled img").exists()).toBe(false);
    expect(w.find("#scheduled script").exists()).toBe(false);
    expect(w.text()).toContain("<img src=x>");
  });
});
