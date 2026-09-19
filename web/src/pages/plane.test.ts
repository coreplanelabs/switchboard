import { describe, expect, it } from "vitest";
import PlanePage from "./PlanePage.vue";
import { mountApp } from "../testing/mount";
import type { PlaneSeed } from "@core/channels/webSeed.js";
import type { PlaneTable } from "@core/core/plane/table.js";
import type { RunView } from "@core/core/runsService.js";

// The plane panel (docs/reference/specs/orchestration-plane.md item 5): the seed's
// rows painted with their owners and health flags, a live run of this process
// linking through its token, a foreign or finished run linking tokenless.

const NOW = Date.parse("2026-09-19T03:00:00Z");
const MIN = 60_000;

function view(over: Partial<RunView> & { id: string }): RunView {
  return { startedAt: NOW - 12 * MIN, finished: false, eventCount: 3, agent: "coding", ...over };
}

function table(over: Partial<PlaneTable> = {}): PlaneTable {
  return {
    at: NOW,
    runs: [
      {
        run: view({
          id: "live-stalled",
          eventsLast5m: 0,
          lastToolCallAt: NOW - 9 * MIN,
          userName: "alice",
          threadKey: "slack:C1:1.0",
        }),
        owner: { id: "slack:U_A", name: "alice" },
        unit: { key: "plan-x:U12", id: "U12", title: "The table" },
        health: ["stalled"],
      },
      { run: view({ id: "live-there", ownerGen: "gen-b" }), owner: { generation: "gen-b" }, health: ["no-signal"] },
      {
        run: view({ id: "done-ok", finished: true, status: "completed", finishedAt: NOW - 2 * MIN, userName: "bob" }),
        owner: { id: "slack:U_B", name: "bob" },
        health: [],
      },
    ],
    units: [
      {
        unit: {
          unit: "plan-x:U12",
          instanceId: "plan-x",
          id: "U12",
          title: "The table",
          branch: "plan/x/u12",
          threads: {},
          sourceUrls: {},
          rounds: [],
          pr: { number: 41, url: "https://example.test/pr/41" },
        },
        instance: { id: "plan-x", repo: "acme/api", createdAt: NOW - 60 * MIN },
        health: ["live"],
      },
      {
        unit: {
          unit: "plan-x:U13",
          instanceId: "plan-x",
          id: "U13",
          title: "The queue",
          branch: "plan/x/u3",
          threads: {},
          sourceUrls: {},
          rounds: [],
          pr: { number: 42, url: "https://example.test/pr/42" },
          ending: { kind: "merge_ready", report: "ok", at: NOW },
        },
        instance: { id: "plan-x", repo: "acme/api", createdAt: NOW - 60 * MIN },
        health: ["merge-ready", "owner-gap"],
      },
    ],
    pullRequests: [
      {
        pr: {
          repo: "acme/api",
          number: 41,
          url: "https://example.test/pr/41",
          title: "feat(runs): the table",
          state: "open",
          checks: { total: 1, pending: ["ci / bot"], failed: [] },
        },
        owner: { unitKey: "plan-x:U12" },
        health: ["pending"],
      },
      { pr: { repo: "acme/api", number: 7, unknown: true }, owner: { person: true }, health: ["unknown"] },
    ],
    windows: [],
    findings: [],
    ...over,
  };
}

const seed = (t: PlaneTable = table(), tokens: Record<string, string> = { "live-stalled": "tok-1" }): PlaneSeed => ({
  page: "plane",
  table: t,
  tokens,
});

describe("PlanePage", () => {
  it("paints the header counts and one row per run, unit and pull request with their health words", () => {
    const w = mountApp(PlanePage, { seed: seed() });
    expect(w.find("[data-plane-head]").text()).toBe("2 live · 1 recent · 2 units · 2 pull requests");
    expect(w.findAll("[data-run]")).toHaveLength(3);
    expect(w.find('[data-run="live-stalled"]').attributes("data-health")).toBe("stalled");
    expect(w.find('[data-run="live-stalled"] [data-flag="stalled"]').text()).toBe("stalled");
    expect(w.find('[data-run="live-stalled"] [data-owner]').text()).toBe("alice");
    expect(w.find('[data-run="live-there"] [data-owner]').text()).toBe("run · on gen-b");
    expect(w.find('[data-unit="plan-x:U13"]').attributes("data-health")).toBe("merge-ready owner-gap");
    expect(w.find('[data-unit="plan-x:U13"] [data-flag="owner-gap"]').text()).toBe("approved, open, nobody's");
    expect(w.find('[data-pr="acme/api#41"] [data-owner]').text()).toBe("plan-x:U12");
    expect(w.find('[data-pr="acme/api#7"] [data-owner]').text()).toBe("a person");
    expect(w.find('[data-pr="acme/api#7"] [data-flag="unknown"]').text()).toBe("unread");
    w.unmount();
  });

  it("links a live run of this process through its token and every other run tokenless", () => {
    const w = mountApp(PlanePage, { seed: seed() });
    const hrefs = w.findAll("[data-run] a").map((a) => a.attributes("href"));
    expect(hrefs).toContain("/runs/live-stalled?t=tok-1");
    expect(hrefs).toContain("/runs/live-there");
    expect(hrefs).toContain("/runs/done-ok");
    expect(w.find('[data-run="live-stalled"] a[href^="/runs/unit/"]').attributes("href")).toBe(
      "/runs/unit/plan-x%3AU12",
    );
    w.unmount();
  });

  it("says so when a section is empty", () => {
    const w = mountApp(PlanePage, { seed: seed(table({ runs: [], units: [], pullRequests: [] })) });
    expect(w.find("[data-plane-head]").text()).toBe("0 live · 0 recent · 0 units · 0 pull requests");
    expect(w.text()).toContain("No run is live or ended in the last hour.");
    expect(w.text()).toContain("No ship unit has a run on the table.");
    expect(w.text()).toContain("No pull request is tracked.");
    w.unmount();
  });
});
