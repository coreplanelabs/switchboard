import { describe, expect, it } from "vitest";
import { CommandRegistry, renderText } from "../commandRegistry.js";
import type { PlaneService } from "../planeService.js";
import type { PlaneTable } from "../plane/table.js";
import type { RunView } from "../runsService.js";
import { callerWith } from "../testing/callers.js";
import {
  planeCommands,
  registerPlaneCommands,
  renderPlaneStop,
  renderPlaneTable,
  type PlaneCommandDeps,
} from "./plane.js";

// Feature: docs/reference/specs/orchestration-plane.md item 4 — `plane show` is one
// typed read over the plane service, under the caller's own `runs:read`
// predicate, rendered as three sections for a terminal and as bullets for chat.

const NOW = Date.parse("2026-09-19T03:00:00Z");
const MIN = 60_000;

function view(over: Partial<RunView> & { id: string }): RunView {
  return { startedAt: NOW - 12 * MIN, finished: false, eventCount: 3, agent: "coding", ...over };
}

const TABLE: PlaneTable = {
  at: NOW,
  runs: [
    {
      run: view({
        id: "11111111-aaaa",
        eventsLast5m: 0,
        lastToolCallAt: NOW - 9 * MIN,
        userId: "slack:U_ALICE",
        userName: "alice",
      }),
      owner: { id: "slack:U_ALICE", name: "alice" },
      unit: { key: "plan-x:U12", id: "U12", title: "The table" },
      health: ["stalled"],
    },
    {
      run: view({
        id: "22222222-bbbb",
        finished: true,
        status: "completed",
        finishedAt: NOW - 3 * MIN,
        userId: "slack:U_BOB",
      }),
      owner: { id: "slack:U_BOB" },
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
        pr: { number: 10041, url: "u" },
      },
      instance: { id: "plan-x", repo: "acme/api", createdAt: NOW - 60 * MIN },
      health: ["live"],
    },
  ],
  pullRequests: [
    {
      pr: { repo: "acme/api", number: 10041, state: "open", checks: { total: 1, pending: ["ci / bot"], failed: [] } },
      owner: { unitKey: "plan-x:U12" },
      health: ["pending"],
    },
    { pr: { repo: "acme/api", number: 10007, unknown: true }, owner: { person: true }, health: ["unknown"] },
  ],
  windows: [],
  findings: [],
};

function setup(table: PlaneTable = TABLE) {
  const asked: unknown[] = [];
  const service: PlaneService = {
    table: async (visibleTo) => {
      asked.push(visibleTo);
      return table;
    },
    stop: async () => ({ kind: "unavailable", reason: "not wired in this test" }),
  };
  const registry = new CommandRegistry<PlaneCommandDeps>({ audit: () => {} });
  registerPlaneCommands(registry);
  const deps: PlaneCommandDeps = { plane: { service: async () => service } };
  return { registry, deps, asked };
}

describe("plane.show", () => {
  it("registers the read under runs:read and the stop under runs:write on every surface", () => {
    expect(planeCommands.map((c) => c.id)).toEqual(["plane.show", "plane.stop"]);
    expect(planeCommands[0]).toMatchObject({ action: "runs:read", effect: "read" });
    expect(planeCommands[0].surfaces).toBeUndefined();
    // `plane stop` is destructive (record 0064's runner_stop move): it
    // ends a whole pipeline and its live children, and nothing restarts them.
    expect(planeCommands[1]).toMatchObject({ action: "runs:write", effect: "write" });
    expect(planeCommands[1]!.annotations?.destructive).toBe(true);
  });

  it("answers the table under the caller's own predicate: an all-channels reader gets every row", async () => {
    const { registry, deps, asked } = setup();
    const res = await registry.invoke("plane.show", { options: {} }, callerWith("cli", "cli:local", "all"), deps);
    expect(res).toMatchObject({ ok: true, value: { at: NOW } });
    expect((res as unknown as { value: PlaneTable }).value.runs.map((r) => r.run.id)).toEqual([
      "11111111-aaaa",
      "22222222-bbbb",
    ]);
    expect(asked).toEqual([{ kind: "all" }]);
  });

  it("a caller without runs:read is refused before the service is asked", async () => {
    const { registry, deps, asked } = setup();
    const res = await registry.invoke(
      "plane.show",
      { options: {} },
      callerWith("mcp", "mcp:agent", ["dispatch"]),
      deps,
    );
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
    expect(asked).toEqual([]);
  });

  it("renders three sections for a terminal, the header counting live, recent, units and pull requests", () => {
    const text = renderPlaneTable(TABLE as unknown as Parameters<typeof renderPlaneTable>[0], "text");
    const lines = text.split("\n");
    expect(lines[0]).toBe("Plane · 1 live · 1 recent · 1 units · 2 pull requests");
    expect(lines[1]).toBe("Runs");
    expect(lines[2]).toMatch(/^11111111\s+coding\s+live\s+12m 00s\s+alice\s+plan-x:U12\s+stalled$/);
    expect(lines[3]).toMatch(/^22222222\s+coding\s+completed\s+9m 00s\s+slack:U_BOB$/);
    expect(lines[4]).toBe("Units");
    expect(lines[5]).toMatch(/^plan-x:U12\s+live\s+#10041\s+The table$/);
    expect(lines[6]).toBe("Pull requests");
    expect(lines[7]).toMatch(/^acme\/api#10041\s+pending\s+plan-x:U12$/);
    expect(lines[8]).toMatch(/^acme\/api#10007\s+unknown\s+a person$/);
  });

  it("renders bullets for chat, with the sections in bold", () => {
    const chat = renderPlaneTable(TABLE as unknown as Parameters<typeof renderPlaneTable>[0], "chat");
    expect(chat).toContain("*Runs*\n• `11111111` — coding · live · 12m 00s · alice · plan-x:U12 · stalled");
    expect(chat).toContain("*Pull requests*\n• acme/api#10041 — pending · plan-x:U12");
  });

  it("a unit whose health is owner-gap prints `merge-ready, unmerged` on chat, the CLI and MCP output — never the raw flag join (record 0066)", () => {
    const table: PlaneTable = {
      ...TABLE,
      units: [{ ...TABLE.units[0], health: ["merge-ready", "owner-gap"] }],
    };
    // `render` is the CLI's and the MCP tool's one text shape; `renderChat` is chat's.
    const text = renderText(planeCommands[0], table as unknown as Parameters<typeof renderPlaneTable>[0]);
    const chat = renderPlaneTable(table as unknown as Parameters<typeof renderPlaneTable>[0], "chat");
    for (const out of [text, chat]) {
      expect(out).toContain("merge-ready, unmerged");
      expect(out).not.toContain("owner-gap");
      expect(out).not.toContain("merge-ready,owner-gap");
    }
    expect(chat).toContain("• plan-x:U12 — The table · merge-ready, unmerged · #10041");
  });

  it("an empty table says so in every section", () => {
    const empty: PlaneTable = { at: NOW, runs: [], units: [], pullRequests: [], windows: [], findings: [] };
    const text = renderText(planeCommands[0], empty as unknown as Parameters<typeof renderPlaneTable>[0]);
    expect(text.split("\n")).toEqual([
      "Plane · 0 live · 0 recent · 0 units · 0 pull requests",
      "Runs",
      "(none)",
      "Units",
      "(none)",
      "Pull requests",
      "(none)",
    ]);
  });
});

describe("plane.stop — the runner_stop move in one command (record 0064)", () => {
  function stopSetup(report: Awaited<ReturnType<PlaneService["stop"]>>) {
    const asked: Array<{ instanceId: string; actor: unknown; predicate: unknown }> = [];
    const service: PlaneService = {
      table: async () => TABLE,
      stop: async (instanceId, actor, predicate) => {
        asked.push({ instanceId, actor, predicate });
        return report;
      },
    };
    const registry = new CommandRegistry<PlaneCommandDeps>({ audit: () => {} });
    registerPlaneCommands(registry);
    const deps: PlaneCommandDeps = { plane: { service: async () => service } };
    return { registry, deps, asked };
  }

  it("stops the instance under the caller's own runs:write predicate, recording the caller as the actor, and renders one line per thing stopped", async () => {
    const report = {
      kind: "stopped" as const,
      instanceId: "plan-x",
      runnerStopped: true,
      parent: { id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", outcome: "stopping" },
      children: [{ id: "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb", outcome: "stopping" }],
    };
    const { registry, deps, asked } = stopSetup(report);
    const res = await registry.invoke(
      "plane.stop",
      { args: ["plan-x"], options: {} },
      callerWith("cli", "cli:local", "all"),
      deps,
    );
    expect(res).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ instanceId: "plan-x", actor: { kind: "cli", id: "cli:local" } });
    const text = renderPlaneStop(report as unknown as Parameters<typeof renderPlaneStop>[0]);
    expect(text).toContain("pipeline plan-x stopped — it starts no more units");
    expect(text).toContain("pipeline run 11111111 — stopping");
    expect(text).toContain("child run 22222222 — stopping");
  });

  it("an unknown instance is not_found; a process without the stores is unavailable by reason; a caller without runs:write is refused before the service is asked", async () => {
    const unknown = stopSetup({ kind: "unknown_instance", instanceId: "plan-x" });
    const notFound = await unknown.registry.invoke(
      "plane.stop",
      { args: ["plan-x"], options: {} },
      callerWith("cli", "cli:local", "all"),
      unknown.deps,
    );
    expect(notFound).toMatchObject({ ok: false, error: "not_found" });

    const bare = stopSetup({ kind: "unavailable", reason: "this process holds no run-history store" });
    const unavailable = await bare.registry.invoke(
      "plane.stop",
      { args: ["plan-x"], options: {} },
      callerWith("cli", "cli:local", "all"),
      bare.deps,
    );
    expect(unavailable).toMatchObject({ ok: false, error: "unavailable" });

    const refusedSetup = stopSetup({ kind: "unknown_instance", instanceId: "plan-x" });
    const refused = await refusedSetup.registry.invoke(
      "plane.stop",
      { args: ["plan-x"], options: {} },
      callerWith("mcp", "mcp:agent", ["dispatch"]),
      refusedSetup.deps,
    );
    expect(refused).toMatchObject({ ok: false, error: "unauthorized" });
    expect(refusedSetup.asked).toEqual([]);
  });

  it("a stop mark that could not be written renders the runner-may-still-be-walking line and no false 'no live child' claim beside real children", () => {
    const text = renderPlaneStop({
      kind: "stopped",
      instanceId: "plan-x",
      runnerStopped: false,
      children: [],
    } as unknown as Parameters<typeof renderPlaneStop>[0]);
    expect(text).toContain("the stop mark could not be written");
    expect(text).toContain("no live child was running");
  });
});
