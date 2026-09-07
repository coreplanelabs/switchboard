import { describe, expect, it } from "vitest";
import ScheduledPage from "./ScheduledPage.vue";
import { mountApp } from "../testing/mount";
import { formatDateTime, formatLocalIso } from "../lib/format";
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
    const next = w.find(".next");
    expect(next.text()).toContain(formatDateTime(RUN_ROW.nextFireAt!, NOW));
    expect(next.text()).not.toContain("UTC");
    expect(next.attributes("title")).toBe(formatLocalIso(RUN_ROW.nextFireAt!));
    expect(t).toContain("(in 1d 2h)");
  });

  it("labels non-run actions and says 'never' for a cron that never fires next", () => {
    const w = mountApp(ScheduledPage, { seed: seed([WATCHDOG_ROW]) });
    expect(w.text()).toContain("resident watchdog — not a run");
    expect(w.text()).toContain("never");
  });

  it("shows the last firing: outcome word ('succeeded'), relative time with the exact local time on hover, a token'd run link, the detail's facts", () => {
    const w = mountApp(ScheduledPage, { seed: seed([RUN_ROW]) });
    expect(w.find(".outcome").text()).toBe("succeeded");
    expect(w.text()).toContain("ago");
    expect(w.find(".fire .when").attributes("title")).toBe(formatLocalIso(RUN_ROW.last!.firedAt));
    const run = w.findAll("a").find((a) => a.text().startsWith("run "));
    expect(run?.attributes("href")).toBe("/runs/0a1b2c3d4e5f6789?t=tok-live");
    expect(run?.text()).toBe("run 0a1b2c3d");
    // the detail drops the reply's own title and keeps the facts, full text on hover
    expect(w.find(".detail").text()).toContain("2 filed");
    expect(w.find(".detail").text()).not.toContain("*Friction proposals*");
    expect(w.find(".detail").attributes("title")).toContain("*Friction proposals*");
  });

  it("shows a bare run id (no link) when the firing's run is not live", () => {
    const row: ScheduledRow = { ...RUN_ROW, last: { ...RUN_ROW.last!, runHref: undefined } };
    const w = mountApp(ScheduledPage, { seed: seed([row]) });
    expect(w.text()).toContain("run 0a1b2c3d");
    expect(w.findAll("a").some((a) => a.text().startsWith("run "))).toBe(false);
  });

  it("says 'never fired' with history available, 'unknown' plus the reason note when it is not", () => {
    const noFiring: ScheduledRow = { ...RUN_ROW, last: undefined };
    expect(mountApp(ScheduledPage, { seed: seed([noFiring]) }).text()).toContain("never fired");
    const w = mountApp(ScheduledPage, { seed: seed([noFiring], "schedules.worker is not configured") });
    expect(w.text()).toContain("unknown");
    expect(w.text()).toContain("Firing history unavailable: schedules.worker is not configured");
  });

  it("says so when no schedule registry is configured (rows null)", () => {
    const w = mountApp(ScheduledPage, { seed: seed(null) });
    expect(w.text()).toContain("No schedule registry configured.");
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

  it("marks the Scheduled tab current with Runs one click away, and Runs current in the site nav", () => {
    const w = mountApp(ScheduledPage, { seed: seed([RUN_ROW]) });
    expect(w.find('nav.tabs a[aria-current="page"]').attributes("href")).toBe("/runs/scheduled");
    expect(w.findAll("nav.tabs a").map((a) => a.attributes("href"))).toEqual(["/runs", "/runs/scheduled"]);
    expect(w.find('nav.site a[aria-current="page"]').attributes("href")).toBe("/runs");
  });
});
