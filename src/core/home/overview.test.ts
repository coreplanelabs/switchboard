// Feature: docs/reference/specs/browser-home.md — state-based work views with bounded detail pages.
import { describe, expect, it } from "vitest";
import { homeOverview } from "./overview.js";
import type { HomeSnapshot, HomeUnit } from "./service.js";

const row = (id: string): HomeUnit => ({
  instance: { id, repo: "sample/app", createdAt: 1 },
  unit: {
    unit: `${id}:U10`,
    instanceId: id,
    id: "U10",
    title: id,
    branch: "work",
    threads: {},
    sourceUrls: {},
    rounds: [],
  },
  conditions: [],
  nextAction: { kind: "unknown" },
});
function snapshot(): HomeSnapshot {
  return {
    organizationId: "org",
    status: "complete",
    access: "authorized",
    needsYou: [],
    moving: [],
    waiting: [],
    pipelines: [],
  };
}
describe("Home work overview", () => {
  it("keeps at most three work shortcuts for each of fifty displayed pipeline cards", () => {
    const source = snapshot();
    for (let i = 0; i < 51; i++) {
      const id = `card-${String(i).padStart(2, "0")}`;
      for (let j = 10; j < 14; j++) {
        const item = row(id);
        item.unit = { ...item.unit, id: `U${j}`, unit: `${id}:U${j}` };
        source.needsYou.push(item);
      }
      source.pipelines.push({
        instance: { id, repo: "sample/app", createdAt: 1 },
        unresolved: 4,
        needsYou: 4,
        moving: 0,
        waiting: 0,
      });
    }
    const page = homeOverview(source, [], { view: "pipelines", page: 1 }, 10);
    expect(page.snapshot.pipelines).toHaveLength(50);
    expect(page.overview.pipelineUnits).toHaveLength(150);
    expect(page.overview.pipelineUnits?.some((row) => row.instance.id === "card-50")).toBe(false);
    expect(page.overview.counts.pipelines).toBe(51);
  });
  it("keeps provider waits, expired states and additional live children outside the current child's movement proof", () => {
    const source = { ...snapshot(), moving: [row("pipeline")] };
    const run = {
      id: "current",
      parentInstanceId: "pipeline",
      idempotencyKey: "pipeline:U10/0/review",
      startedAt: 1,
      finished: false,
      eventCount: 0,
      liveState: { state: "working" as const, since: 1, bound: 1000 },
    };
    const runs = [
      run,
      { ...run, id: "additional" },
      { ...run, id: "provider", liveState: { state: "waiting_provider" as const, since: 1, bound: 1000 } },
      { ...run, id: "expired", liveState: { state: "working" as const, since: 1, bound: 2 } },
      { ...run, id: "stopping", stop: { mode: "soft" as const, state: "stopping" as const } },
    ];
    expect(homeOverview(source, runs, { view: "moving", page: 1 }, 10).overview.runs.map((row) => row.id)).toEqual([
      "additional",
      "current",
    ]);
    expect(homeOverview(source, runs, { view: "waiting", page: 1 }, 10).overview.runs.map((row) => row.id)).toEqual([
      "provider",
    ]);
    const held = homeOverview(source, runs, { view: "investigation", page: 1 }, 10);
    expect(held.overview.runs.map((row) => row.id)).toEqual(["expired", "stopping"]);
    expect(held.overview.counts).toMatchObject({ moving: 2, waiting: 1, investigation: 2 });
  });
  it("keeps old unfinished work reachable and separates recorded waits from unknown and failed work", () => {
    const unknown = row("unknown");
    const wait = row("checks");
    wait.conditions = [
      {
        id: "checks:U10:progress",
        unitKey: "checks:U10",
        revision: 1,
        state: "open",
        owner: { kind: "external", label: "GitHub checks" },
        summary: "Checks are running",
        nextAction: "Wait for checks",
      },
    ];
    wait.nextAction = { kind: "recorded", text: "Wait for checks" };
    const failure = row("failed");
    failure.conditions = [
      { ...wait.conditions[0]!, id: "failed:U10:failure", unitKey: "failed:U10", owner: { kind: "unknown" } },
    ];
    failure.nextAction = wait.nextAction;
    const source = { ...snapshot(), waiting: [unknown, wait, failure] };
    expect(homeOverview(source, [], { view: "waiting", page: 1 }, 2).snapshot.waiting.map((r) => r.unit.unit)).toEqual([
      "checks:U10",
    ]);
    const investigation = homeOverview(source, [], { view: "investigation", page: 1 }, 2);
    expect(investigation.snapshot.waiting.map((r) => r.unit.unit)).toEqual(["failed:U10", "unknown:U10"]);
    expect(investigation.overview.counts).toMatchObject({ waiting: 1, investigation: 2 });
  });
  it("pages a production-sized backlog with complete counts and no age cutoff", () => {
    const source = {
      ...snapshot(),
      waiting: Array.from({ length: 1040 }, (_, i) => row(`work-${String(i).padStart(4, "0")}`)),
    };
    const first = homeOverview(source, [], { view: "investigation", page: 1 }, 2);
    expect(first.snapshot.waiting).toHaveLength(50);
    expect(first.overview.counts.investigation).toBe(1040);
    const keys = new Set<string>();
    for (let page = 1; page <= 21; page++)
      for (const item of homeOverview(source, [], { view: "investigation", page }, 2).snapshot.waiting)
        keys.add(item.unit.unit);
    expect(keys.size).toBe(1040);
    expect(homeOverview(source, [], { view: "investigation", page: 21 }, 2).overview.pages).toBe(21);
  });
  it("shows standalone runs without counting a pipeline child twice and excludes ended runs", () => {
    const source = { ...snapshot(), moving: [{ ...row("pipeline") }] };
    const run = {
      id: "review",
      startedAt: 1,
      finished: false,
      eventCount: 0,
      liveState: { state: "working" as const, since: 1, bound: 1000 },
    };
    const result = homeOverview(
      source,
      [
        run,
        { ...run, id: "child", parentInstanceId: "pipeline", idempotencyKey: "pipeline:U10/0/review" },
        { ...run, id: "ended", finished: true },
      ],
      { view: "moving", page: 1 },
      2,
    );
    expect(result.overview.counts.moving).toBe(2);
    expect(result.overview.runs.map((r) => r.id)).toEqual(["child", "review"]);
    expect(result.snapshot.moving).toEqual([]);
  });
});
